/**
 * Intake inside code channels (docs/code-channels.md, Inside the channel). Inert unless `codeChannelsEnabled()` and
 * the channel is recorded in `code_channels` (or is adopted here: a mention in a Slack-created agent channel).
 *
 * - A top-level message belongs to the channel's one conversation, `${channel}:0` (rules.ts conversationRootTs).
 * - A thread reply keeps its own thread, `${channel}:${thread_ts}`, and follows the ordinary channel-thread rules:
 *   ignored until the bot is @mentioned in that thread, then the usual engaged-thread rules.
 * - A marked parent-agent post (parent-message.ts) at the top level starts a turn for the requester
 *   (`acceptParentPost`). The bot's own code calls it right after posting (src/features/code-channels/open.ts
 *   postParentMessage), so the turn doesn't depend on Slack echoing the post back with its metadata; when the echo
 *   does arrive, intake calls it again and the per-message claim makes the second call a no-op.
 * - Any human message (or parent post) resets the idle clock; a message in a channel marked archived means someone
 *   reopened it, so it's live again.
 */
import { appendEvent, codeChannelThreadId, parseThreadId } from '../core/events.js';
import { isChannelReadOnly } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { hasAgreed } from '../features/privacy.js';
import { adoptIfAgentChannel } from '../features/code-channels/adopt.js';
import { parseParentMessage, type ParentMessageMarker } from '../features/code-channels/parent-message.js';
import { codeChannelsEnabled } from '../features/code-channels/settings.js';
import { getCodeChannel, isCodeChannel, touchCodeChannel, unarchiveCodeChannel } from '../features/code-channels/store.js';
import { restoreSessionStatus } from './agent-session.js';
import { holdForConsent } from './consent.js';
import { addToBatch } from './debounce.js';
import { guardEntry } from './entry.js';
import { isTopLevel } from './rules.js';
import { showIntakeStatus } from './session-status.js';
import { storeMessage, upsertThread, type SlackMessage } from './store.js';

export interface CodeChannelRoute {
  /** Top-level: the message belongs to `${channel}:0`. */
  topLevel: boolean;
  /** A verified parent-agent post (top level, from the bot itself, marker matches the channel's parent thread). */
  parent: ParentMessageMarker | null;
}

interface RouteInput {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  metadata?: unknown;
}

/**
 * Is this message in a code channel, and how does it route? Null for everything else (feature off, DMs, ordinary
 * channels). `mentionsBot`: only a mention looks the channel up in Slack for adoption (conversations.info, cached).
 */
export async function routeCodeChannel(ev: RouteInput, o: { isDm: boolean; isBot: boolean; mentionsBot: boolean; botId?: string }): Promise<CodeChannelRoute | null> {
  if (o.isDm) return null;
  if (!(await codeChannelsEnabled())) return null;
  let known = await isCodeChannel(ev.channel);
  if (!known && !o.isBot && o.mentionsBot) {
    known = Boolean(await adoptIfAgentChannel(ev.channel, ev.user).catch((err) => (log.warn({ err, channel: ev.channel }, 'code channel adoption failed'), null)));
  }
  if (!known) return null;
  const topLevel = isTopLevel(ev);
  const parent = topLevel && o.isBot ? await verifiedParentPost(ev, o.botId) : null;
  return { topLevel, parent };
}

async function verifiedParentPost(ev: RouteInput, botId: string | undefined): Promise<ParentMessageMarker | null> {
  const marker = parseParentMessage(ev);
  if (!marker || !botId || ev.bot_id !== botId) return null;
  return (await markerMatchesChannel(ev, marker)) ? marker : null;
}

/** The marker's parent thread is the channel's recorded parent thread. */
async function markerMatchesChannel(ev: { channel: string; ts: string }, marker: ParentMessageMarker): Promise<boolean> {
  const row = await getCodeChannel(ev.channel);
  if (!row?.parentThreadId || row.parentThreadId !== marker.parentThreadId) {
    log.warn({ channel: ev.channel, ts: ev.ts, marker }, 'parent post marker does not match the code channel; ignored');
    return false;
  }
  return true;
}

/** The dedupe key a parent post is claimed under (slack_events_seen, pruned by retention after ~2 days). Pure. */
export function parentPostClaimKey(channelId: string, ts: string): string {
  return `cc-parent:${channelId}:${ts}`;
}

/** Claim a parent post's turn: true for the first caller only (the direct call after posting, or Slack's echo). */
async function claimParentPost(channelId: string, ts: string): Promise<boolean> {
  const rows = await sql`insert into slack_events_seen (event_id) values (${parentPostClaimKey(channelId, ts)}) on conflict do nothing returning event_id`;
  return rows.length > 0;
}

async function releaseParentPost(channelId: string, ts: string): Promise<void> {
  await sql`delete from slack_events_seen where event_id = ${parentPostClaimKey(channelId, ts)}`;
}

/**
 * What became of a parent post's turn:
 * - `accepted`: batched for the requester (the turn runs); `duplicate`: the other path (our own call or Slack's echo)
 *   took it first and ran the same checks;
 * - `held_for_consent`: the requester hasn't agreed to the privacy policy: the post is held and they get the usual
 *   consent prompt in the parent thread, and it is answered once they agree (consent.ts holdForConsent);
 * - `refused` (entry guard: limits, suspension), `read_only` (the channel is), `deleted`, `not_verified` (feature off
 *   or the marker doesn't match the row): no turn.
 */
export type ParentPostOutcome = 'accepted' | 'duplicate' | 'held_for_consent' | 'refused' | 'read_only' | 'deleted' | 'not_verified';

/** The parent post will be (or already was) answered in the channel. Pure. */
export function parentPostTurnStarts(o: ParentPostOutcome | (string & {}) | null): boolean {
  return o === 'accepted' || o === 'duplicate';
}

/**
 * A verified parent post (`marker` already checked against the channel's row) in a code channel's conversation:
 * store it, reset the idle clock, and start a turn in `${channel}:0` for the requester (batch reason `parent`, no
 * gate), behind the same checks as any message there: read-only channel, the entry guard (limits, suspension) and
 * consent (a requester who hasn't agreed is held behind the consent prompt, shown in the parent thread where they
 * are). Storage and bookkeeping are idempotent; the events and the batch happen once per post (claimParentPost),
 * whichever of the two paths gets there first.
 */
export async function acceptParentPost(channelId: string, msg: SlackMessage, marker: ParentMessageMarker): Promise<ParentPostOutcome> {
  const threadId = codeChannelThreadId(channelId);
  await noteCodeChannelActivity(channelId, marker.requesterId);
  await upsertThread({ id: threadId, channelId, threadTs: '0', isDm: false });
  const { deleted } = await storeMessage(channelId, threadId, msg);
  if (deleted) return 'deleted';
  if (!(await claimParentPost(channelId, msg.ts))) {
    log.debug({ channelId, ts: msg.ts }, 'parent post already taken');
    return 'duplicate';
  }
  // A failure from here on would lose the turn (the other path would find it claimed): release the claim so a retry
  // (the job's, or Slack's echo) can take it.
  try {
    await appendEvent(threadId, 'message', msg.bot_id ? `bot:${msg.bot_id}` : null, { ts: msg.ts, bot: true });
    await appendEvent(threadId, 'parent_message', marker.requesterId, { ts: msg.ts, parentThreadId: marker.parentThreadId });
    // The conversation is always engaged (like a DM).
    await sql`update threads set engaged = true, last_addressed_at = now(), messages_since_addressed = 0, last_activity_at = now() where id = ${threadId}`;
    if (await isChannelReadOnly(channelId)) return 'read_only';
    const entry = await guardEntry(marker.requesterId, channelId);
    if (!entry.ok) return 'refused';
    if (!(await hasAgreed(marker.requesterId))) {
      const parent = parseThreadId(marker.parentThreadId);
      await holdForConsent({
        userId: marker.requesterId,
        channelId: parent.channelId,
        // The prompt throttle is per conversation, like intake's (a DM is one conversation).
        conversation: parent.channelId.startsWith('D') ? parent.channelId : marker.parentThreadId,
        promptThreadTs: parent.threadTs,
        messageTs: msg.ts,
        item: { kind: 'batch', threadId, ts: msg.ts, reason: 'parent' },
      });
      return 'held_for_consent';
    }
    showIntakeStatus(threadId, marker.requesterId, msg.ts);
    await addToBatch(threadId, marker.requesterId, msg.ts, 'parent');
    return 'accepted';
  } catch (err) {
    await releaseParentPost(channelId, msg.ts).catch((e) => log.warn({ err: e, channelId, ts: msg.ts }, 'releasing a parent post claim failed'));
    throw err;
  }
}

/**
 * The bot just posted a parent post (open.ts postParentMessage): start its turn now rather than waiting for Slack's
 * echo (which may arrive without the metadata). Checks the marker against the channel's row like intake does.
 */
export async function acceptOwnParentPost(channelId: string, msg: SlackMessage, marker: ParentMessageMarker): Promise<ParentPostOutcome> {
  if (!(await codeChannelsEnabled())) return 'not_verified';
  if (!(await markerMatchesChannel({ channel: channelId, ts: msg.ts }, marker))) return 'not_verified';
  return acceptParentPost(channelId, msg, marker);
}

/**
 * A human message (or parent post) arrived in a code channel: reset the idle clock. A warned channel's `suspended`
 * status is put back; a channel marked archived was reopened in Slack, so it's live again (the bot resumes with the
 * stored context). Never throws.
 */
export async function noteCodeChannelActivity(channelId: string, actor: string | null): Promise<void> {
  try {
    const before = await touchCodeChannel(channelId);
    if (!before) return;
    const threadId = codeChannelThreadId(channelId);
    if (before.wasArchived && (await unarchiveCodeChannel(channelId))) {
      await appendEvent(threadId, 'code_channel_reopened', actor, {});
      log.info({ channelId }, 'code channel reopened');
    }
    // The archive warning set `suspended`; the clock restarted, so back to the resting status.
    if (before.wasWarned || before.wasArchived) await restoreSessionStatus(threadId);
  } catch (err) {
    log.warn({ err, channelId }, 'code channel activity bookkeeping failed');
  }
}
