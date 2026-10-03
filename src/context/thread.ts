// OWNER: tools/context module.
/**
 * Thread context for front-agent turns. Format (see format.ts): one message per line, prefixed with its ts:
 *   [1727950000.123456] <@U123> Ingo: text [file: budget.csv] [image img_3: screenshot.png, from Ingo]
 *   [42 earlier replies not shown]
 *   [1727950100.000200] [bot] Smasnug (you): …
 * Tell the model in the system prompt that the bracketed number is the message ts (for react / read_thread).
 */
import { limits, env } from '../config.js';
import { sql } from '../db/index.js';
import { getBotIdentity } from '../core/slack.js';
import { parseThreadId } from '../core/events.js';
import type { StoredMessage } from '../core/types.js';
import { log } from '../log.js';
import type { TurnTiming } from '../core/timing.js';
import { compareTs, formatMessages, formatThread, selectThread, userIdsIn, type FormatEnv, type RenderMsg } from './format.js';
import { assignImageIds } from './images.js';
import { fetchHistoryAfter, fetchHistoryBefore, fetchReplies, fromStored, storeMessages } from './slack-messages.js';
import { getUserNames } from './users.js';

export interface RenderedThreadContext {
  /** Parent + last N replies (with `[k earlier replies not shown]`), author-labelled, truncated, file/image placeholders. */
  history: string;
  /** ~5 channel messages around the thread parent. Empty for DMs. */
  channelContext: string;
  /** The turn's new messages rendered the same way. */
  newMessages: string;
}

const CHANNEL_BEFORE = Math.max(1, limits.contextChannelMessages - 2);
const CHANNEL_AFTER = limits.contextChannelMessages - CHANNEL_BEFORE;
const MAX_CHARS = limits.messageTruncateTokens * 4;

interface ThreadRow {
  id: string;
  channelId: string;
  threadTs: string;
  isDm: boolean;
  backfilled: boolean;
}

/** Make sure the threads row exists (the pipeline normally creates it first). */
export async function ensureThread(threadId: string): Promise<ThreadRow> {
  const { channelId, threadTs } = parseThreadId(threadId);
  const isDm = channelId.startsWith('D');
  await sql`insert into threads (id, channel_id, thread_ts, is_dm) values (${threadId}, ${channelId}, ${threadTs}, ${isDm})
    on conflict (id) do nothing`;
  const [row] = await sql<ThreadRow[]>`select id, channel_id, thread_ts, is_dm, backfilled from threads where id = ${threadId}`;
  return row!;
}

/** Pull the thread (and channel context around its parent) from Slack into `messages`, once per thread. */
export async function backfillThread(thread: ThreadRow): Promise<void> {
  if (thread.backfilled) return;
  try {
    const replies = await fetchReplies(thread.channelId, thread.threadTs);
    await storeMessages(thread.channelId, thread.id, replies);
  } catch (err) {
    // Transient failures retry on the next turn; the context still renders from whatever is stored.
    log.warn({ err, threadId: thread.id }, 'thread backfill failed');
    return;
  }
  if (!thread.isDm) {
    try {
      // Over-fetch: joins/leaves are dropped when stored.
      const before = await fetchHistoryBefore(thread.channelId, { latest: thread.threadTs, limit: CHANNEL_BEFORE + 7 });
      const after = CHANNEL_AFTER > 0 ? await fetchHistoryAfter(thread.channelId, thread.threadTs, CHANNEL_AFTER) : [];
      await storeMessages(thread.channelId, null, [...before, ...after]);
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'channel context backfill failed');
    }
  }
  await sql`update threads set backfilled = true where id = ${thread.id}`;
  thread.backfilled = true;
}

async function loadThreadMessages(threadId: string): Promise<RenderMsg[]> {
  const rows = await sql<StoredMessage[]>`select * from messages where thread_id = ${threadId} and not deleted`;
  return rows.map(fromStored);
}

/** Top-level channel messages near the parent (stored by backfill or by the pipeline). */
async function loadChannelContext(thread: ThreadRow): Promise<RenderMsg[]> {
  const parentS = Number(thread.threadTs.split('.')[0]);
  const lo = String(parentS - 86400);
  const hi = String(parentS + 86400);
  const rows = await sql<StoredMessage[]>`
    select * from messages
    where channel_id = ${thread.channelId} and not deleted and ts <> ${thread.threadTs}
      and (thread_id is null or thread_id = channel_id || ':' || ts)
      and ts::numeric between ${lo}::numeric and ${hi}::numeric`;
  const msgs = rows.map(fromStored).sort((a, b) => compareTs(a.ts, b.ts));
  const before = msgs.filter((m) => compareTs(m.ts, thread.threadTs) < 0).slice(-CHANNEL_BEFORE);
  const after = msgs.filter((m) => compareTs(m.ts, thread.threadTs) > 0).slice(0, CHANNEL_AFTER);
  return [...before, ...after];
}

/** Build the FormatEnv for a set of messages: user names, image ids (assigned now), bot identity. */
export async function formatEnvFor(threadId: string, msgs: RenderMsg[]): Promise<FormatEnv> {
  const [names, imageIds, self] = await Promise.all([
    getUserNames(userIdsIn(msgs)),
    assignImageIds(threadId, msgs),
    getBotIdentity().catch(() => undefined),
  ]);
  return { names, imageIds, self: { ...self, name: env.BOT_DISPLAY_NAME }, maxChars: MAX_CHARS };
}

/**
 * Render a thread for a front-agent turn. Backfills from conversations.replies on first use of a thread
 * (threads.backfilled), and assigns stable `img_N` ids to images (thread_images).
 */
export async function renderThreadContext(threadId: string, opts: { newMessageTs: string[]; timing?: TurnTiming }): Promise<RenderedThreadContext> {
  const span = <T,>(name: string, fn: () => Promise<T>) => (opts.timing ? opts.timing.span(name, fn) : fn());
  const thread = await span('ctx_ensure_thread', () => ensureThread(threadId));
  await span('ctx_backfill', () => backfillThread(thread));

  const all = await span('ctx_load_thread', () => loadThreadMessages(threadId));
  const newSet = new Set(opts.newMessageTs);
  // New messages may live outside the thread rows (e.g. a top-level DM message) — load them by ts too.
  const newMsgs = opts.newMessageTs.length ? await span('ctx_load_new', () => loadByTs(thread.channelId, opts.newMessageTs)) : [];
  const newest = newMsgs.reduce<string | undefined>((acc, m) => (!acc || compareTs(m.ts, acc) > 0 ? m.ts : acc), undefined);
  // History = everything before the turn's newest message, minus the new messages themselves. Anything newer
  // arrives via the inbox (renderMessages), so it would be duplicated here.
  const history = all.filter((m) => !newSet.has(m.ts) && (!newest || compareTs(m.ts, newest) < 0 || m.ts === thread.threadTs));
  const sel = selectThread(history, thread.threadTs, limits.contextReplies);
  const channelMsgs = thread.isDm ? [] : await span('ctx_channel', () => loadChannelContext(thread));

  const shown = [...(sel.parent ? [sel.parent] : []), ...sel.replies, ...newMsgs, ...channelMsgs];
  const fenv = await span('ctx_format_env', () => formatEnvFor(threadId, shown));
  return {
    history: formatThread(sel, fenv),
    channelContext: formatMessages(channelMsgs, fenv),
    newMessages: formatMessages(newMsgs, fenv),
  };
}

async function loadByTs(channelId: string, ts: string[]): Promise<RenderMsg[]> {
  if (!ts.length) return [];
  const rows = await sql<StoredMessage[]>`select * from messages where channel_id = ${channelId} and ts in ${sql(ts)} and not deleted`;
  return rows.map(fromStored);
}

/** Render specific messages (e.g. inbox messages injected mid-turn) in the same format. */
export async function renderMessages(threadId: string, ts: string[]): Promise<string> {
  const { channelId } = parseThreadId(threadId);
  await ensureThread(threadId);
  const msgs = await loadByTs(channelId, ts);
  const fenv = await formatEnvFor(threadId, msgs);
  return formatMessages(msgs, fenv);
}

/** Render raw Slack API messages (read_thread / read_channel) in the context format; registers their images. */
export async function renderRawMessages(threadId: string, msgs: RenderMsg[]): Promise<string> {
  await ensureThread(threadId);
  const fenv = await formatEnvFor(threadId, msgs);
  return formatMessages(msgs, fenv);
}
