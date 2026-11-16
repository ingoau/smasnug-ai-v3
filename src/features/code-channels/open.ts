/**
 * Opening a code channel (docs/code-channels.md, Opening one), shared by the `open_code_channel` tool (fork / brief)
 * and the `move_to_code_channel` button. Order matters for "nothing half-created left unrecorded": the seed summary
 * is written before Slack creates anything, and the `code_channels` row is recorded right after
 * `agents.conversations.create` returns, before any post or invite that could fail.
 *
 * Retries are safe: the session id is derived from the trigger (Slack returns the same channel), the row insert is
 * idempotent, and every post / invite carries an idempotency key derived from the channel.
 *
 * How the channel's first turn starts: the brief (task) and, after a fork seed, the quoted latest user message are
 * posted as *parent posts* (parent-message.ts: the bot under "smasnug ai · from <parent>", with the marker metadata).
 * Right after posting, postParentMessage hands them to src/pipeline/code-channel-intake.ts (acceptOwnParentPost), which
 * records a `parent_message` and starts a turn in `${channel}:0` for the requester, so the channel answers like any
 * other message there: consent, limits, the thread lock and status all apply. Slack's echo of the post is deduped. The fork summary itself (and a button's seed) is an ordinary bot post: stored,
 * no turn.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config.js';
import { appendEvent, codeChannelThreadId, parseThreadId, threadTsArg } from '../../core/events.js';
import { getBotIdentity, slackCall, slackErrorCode } from '../../core/slack.js';
import { getConversationInfo, type ConversationInfo } from '../../context/conversation.js';
import { log } from '../../log.js';
import { acceptOwnParentPost } from '../../pipeline/code-channel-intake.js';
import { neutralizeBroadcasts } from '../../pipeline/guidelines.js';
import { createCodeChannel } from './api.js';
import { codeChannelDisplayName } from './ids.js';
import { briefText, createOptions, forkHandoffText, forkSeedText } from './logic.js';
import { parentMessageMetadata, parentPostUsername } from './parent-message.js';
import { generateSeedSummary } from './seed.js';
import { createCodeChannelRow, getCodeChannelBySession, setCodeChannelSeedTs, type CodeChannel } from './store.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export async function permalinkOf(channel: string, ts: string | null | undefined): Promise<string | undefined> {
  if (!ts) return undefined;
  return slackCall<any>('chat.getPermalink', { channel, message_ts: ts })
    .then((r) => (typeof r?.permalink === 'string' ? r.permalink : undefined))
    .catch(() => undefined);
}

export function isDmConversation(channelId: string, info: Pick<ConversationInfo, 'kind'> | null): boolean {
  return info ? info.kind === 'dm' || info.kind === 'group_dm' : channelId.startsWith('D');
}

/** How a parent post names the conversation it came from ("#general", "a DM"). */
export function parentLabel(info: Pick<ConversationInfo, 'kind' | 'name'> | null): string {
  if (!info) return 'a thread';
  if (info.kind === 'dm') return 'a DM';
  if (info.kind === 'group_dm') return 'a group DM';
  return info.name ? `#${info.name}` : 'a channel';
}

/**
 * conversations.invite (bot token; `force` invites the valid ones when some ids are bad). Someone already there is
 * not an error. Returns an error code, or null when it worked.
 */
export async function inviteUsers(channelId: string, users: readonly string[], key: string): Promise<string | null> {
  if (!users.length) return null;
  try {
    await slackCall('conversations.invite', { channel: channelId, users: users.join(','), force: true }, { idempotencyKey: `cc-invite:${channelId}:${key}` });
    return null;
  } catch (err) {
    const code = slackErrorCode(err) ?? 'unknown';
    if (code === 'already_in_channel' || code === 'cant_invite_self') return null;
    log.warn({ err, channelId, users }, 'code channel invite failed');
    return code;
  }
}

/**
 * Post as the bot for the parent thread's agent: custom username + the parent marker, then start the channel's turn
 * for the requester right away (acceptOwnParentPost; Slack's echo of the post is deduped). A failure to start the
 * turn is logged, not thrown: the post is there, and the echo may still start it.
 */
export async function postParentMessage(o: { channelId: string; parentThreadId: string; requesterId: string; label: string; text: string; key: string }): Promise<string> {
  const text = neutralizeBroadcasts(o.text);
  const username = parentPostUsername(env.BOT_DISPLAY_NAME, o.label);
  const marker = { parentThreadId: o.parentThreadId, requesterId: o.requesterId };
  const res = await slackCall<any>(
    'chat.postMessage',
    { channel: o.channelId, text, username, metadata: parentMessageMetadata(marker), unfurl_links: false },
    { idempotencyKey: o.key },
  );
  const ts = String(res.ts);
  const bot = await getBotIdentity().catch(() => undefined);
  const echo = res.message && typeof res.message === 'object' ? res.message : {};
  const msg = { text, username, ...(bot ? { user: bot.userId, bot_id: bot.botId } : {}), ...echo, ts };
  await acceptOwnParentPost(o.channelId, msg, marker).catch((err) => log.warn({ err, channelId: o.channelId, ts }, 'starting the parent post turn failed'));
  return ts;
}

export type OpenMode = 'fork' | 'task' | 'button';

export interface OpenInput {
  mode: OpenMode;
  /** The model's / presser's name for it; the channel is "smasnug ai: <name>". */
  name: string;
  /** deriveSessionId(...) of the trigger. */
  sessionId: string;
  /** The thread it's opened from (its parent). */
  sourceThreadId: string;
  /** The origin message in the source thread's channel (fork: the latest user message; task: the trigger; button: the reply). */
  originTs: string | null;
  /** The origin's author: Slack invites them itself when there is an origin link. */
  originAuthorId: string | null;
  requesterId: string;
  createdBy: string;
  /** Invited explicitly, no confirmation (the speaker; the presser and the requester). */
  explicitInvites: string[];
  private?: boolean;
  /** task: the brief, posted as the first message (a parent post: one ordinary turn runs on it). */
  brief?: string;
  /** fork: the latest user message, quoted after the seed as a parent post so the channel answers it. */
  handoff?: { authorId: string; text: string };
  abortSignal?: AbortSignal;
}

export interface OpenResult {
  channel: CodeChannel;
  /** The row already existed (a retry): nothing new was created at Slack. */
  existed: boolean;
  seedTs: string | null;
  seedPermalink?: string;
  originIsDm: boolean;
  /** Steps after the channel existed that failed (reported to the agent; the channel stays). */
  problems: string[];
}

/** Open (or, on a retry, finish opening) a code channel. Throws CodeChannelError when Slack refuses to create it. */
export async function openCodeChannel(i: OpenInput): Promise<OpenResult> {
  const { channelId: sourceChannelId } = parseThreadId(i.sourceThreadId);
  const info = await getConversationInfo(sourceChannelId).catch(() => null);
  const originIsDm = isDmConversation(sourceChannelId, info);
  const origin = i.originTs ? { channelId: sourceChannelId, ts: i.originTs } : null;
  const problems: string[] = [];

  // The seed comes first: a failed summary must not leave a channel behind without one. A model failure still opens
  // the channel (with a note instead of the summary).
  const existing = await getCodeChannelBySession(i.sessionId);
  let seedSummary: string | null = existing?.seedSummary ?? null;
  if (i.mode !== 'task' && !existing) {
    seedSummary = await generateSeedSummary({ sourceThreadId: i.sourceThreadId, upToTs: i.originTs, userId: i.requesterId, abortSignal: i.abortSignal }).catch((err) => {
      log.warn({ err, threadId: i.sourceThreadId }, 'code channel seed summary failed');
      problems.push('the summary of the thread could not be written');
      return null;
    });
  }

  const opts = createOptions({ originIsDm, private: i.private, origin });
  const name = codeChannelDisplayName(i.name, env.BOT_DISPLAY_NAME);
  const { channelId } = await createCodeChannel({ name, sessionId: i.sessionId, ...opts });
  const { row, created } = await createCodeChannelRow({
    channelId,
    sessionId: i.sessionId,
    kind: i.mode === 'task' ? 'task' : 'fork',
    name,
    parentThreadId: i.sourceThreadId,
    origin,
    seedSummary: seedSummary ? neutralizeBroadcasts(seedSummary) : null,
    brief: i.brief ?? null,
    createdBy: i.createdBy,
    requesterId: i.requesterId,
    isPrivate: Boolean(opts.isPrivate) || info?.kind === 'private_channel',
  });
  if (created) {
    const ev = { channelId, kind: row.kind, mode: i.mode, origin, linked: Boolean(opts.origin) };
    await appendEvent(codeChannelThreadId(channelId), 'code_channel_opened', i.createdBy, { ...ev, parentThreadId: i.sourceThreadId });
    await appendEvent(i.sourceThreadId, 'code_channel_opened', i.createdBy, ev);
    log.info({ channelId, sourceThreadId: i.sourceThreadId, mode: i.mode, originIsDm }, 'code channel opened');
  }

  // Slack invites the origin's author when there is an origin link; everyone else named here is invited by us.
  const bot = await getBotIdentity().catch(() => undefined);
  const invite = [...new Set(i.explicitInvites)].filter((u) => u && u !== bot?.userId && !(opts.origin && u === i.originAuthorId));
  const inviteErr = await inviteUsers(channelId, invite, hash(invite.join(',')));
  if (inviteErr) problems.push(`inviting ${invite.map((u) => `<@${u}>`).join(', ')} failed (${inviteErr})`);

  const label = parentLabel(info);
  const sourcePermalink = await permalinkOf(sourceChannelId, i.originTs);
  let seedTs: string | null = row.seedTs;
  try {
    if (i.mode === 'task') {
      seedTs = await postParentMessage({
        channelId,
        parentThreadId: i.sourceThreadId,
        requesterId: i.requesterId,
        label,
        text: briefText({ requesterId: i.requesterId, brief: i.brief ?? '', ...(sourcePermalink ? { permalink: sourcePermalink } : {}) }),
        key: `cc-seed:${channelId}`,
      });
    } else {
      const res = await slackCall<any>(
        'chat.postMessage',
        { channel: channelId, text: neutralizeBroadcasts(forkSeedText({ permalink: sourcePermalink, summary: row.seedSummary ?? seedSummary })), unfurl_links: false },
        { idempotencyKey: `cc-seed:${channelId}` },
      );
      seedTs = String(res.ts);
    }
    if (seedTs && seedTs !== row.seedTs) await setCodeChannelSeedTs(channelId, seedTs);
  } catch (err) {
    log.warn({ err, channelId }, 'code channel seed post failed');
    problems.push(`posting the first message failed (${slackErrorCode(err) ?? 'error'})`);
  }

  if (i.mode === 'fork' && i.handoff && seedTs) {
    await postParentMessage({
      channelId,
      parentThreadId: i.sourceThreadId,
      requesterId: i.handoff.authorId,
      label,
      text: forkHandoffText({ authorId: i.handoff.authorId, text: i.handoff.text, ...(sourcePermalink ? { permalink: sourcePermalink } : {}) }),
      key: `cc-handoff:${channelId}`,
    }).catch((err) => {
      log.warn({ err, channelId }, 'code channel hand-off post failed');
      problems.push(`passing on the latest message failed (${slackErrorCode(err) ?? 'error'})`);
    });
  }

  const seedPermalink = await permalinkOf(channelId, seedTs);
  return { channel: { ...row, seedTs }, existed: !created, seedTs, ...(seedPermalink ? { seedPermalink } : {}), originIsDm, problems };
}

/** Post a line into a thread as the bot (the source thread's link, report_to_parent). */
export async function postInThread(threadId: string, text: string, key: string): Promise<string | null> {
  const { channelId, threadTs } = parseThreadId(threadId);
  const res = await slackCall<any>('chat.postMessage', { channel: channelId, ...threadTsArg(threadTs), text: neutralizeBroadcasts(text), unfurl_links: false }, { idempotencyKey: key });
  return res?.ts ? String(res.ts) : null;
}
