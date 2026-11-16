/**
 * Intake inside code channels (docs/code-channels.md, Inside the channel). Inert unless `codeChannelsEnabled()` and
 * the channel is recorded in `code_channels` (or is adopted here: a mention in a Slack-created agent channel).
 *
 * - A top-level message belongs to the channel's one conversation, `${channel}:0` (rules.ts conversationRootTs).
 * - A thread reply keeps its own thread, `${channel}:${thread_ts}`, and follows the ordinary channel-thread rules:
 *   ignored until the bot is @mentioned in that thread, then the usual engaged-thread rules.
 * - A marked parent-agent post (parent-message.ts) at the top level starts a turn for the requester.
 * - Any human message (or parent post) resets the idle clock; a message in a channel marked archived means someone
 *   reopened it, so it's live again.
 */
import { appendEvent, codeChannelThreadId } from '../core/events.js';
import { log } from '../log.js';
import { adoptIfAgentChannel } from '../features/code-channels/adopt.js';
import { parseParentMessage, type ParentMessageMarker } from '../features/code-channels/parent-message.js';
import { codeChannelsEnabled } from '../features/code-channels/settings.js';
import { getCodeChannel, isCodeChannel, touchCodeChannel, unarchiveCodeChannel } from '../features/code-channels/store.js';
import { restoreSessionStatus } from './agent-session.js';
import { isTopLevel } from './rules.js';

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
  const row = await getCodeChannel(ev.channel);
  if (!row?.parentThreadId || row.parentThreadId !== marker.parentThreadId) {
    log.warn({ channel: ev.channel, ts: ev.ts, marker }, 'parent post marker does not match the code channel; ignored');
    return null;
  }
  return marker;
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
