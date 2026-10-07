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
import { authorsMostRecentFirst, compareTs, formatMessages, formatThread, userIdsIn, type FormatEnv, type RenderMsg } from './format.js';
import { estimateRenderedChars } from '../tools/paging.js';
import { loadThreadSummary, requestThreadSummary } from './summary.js';
import { planHistoryWindow, type HistoryWindow } from './window.js';
import { assignImageIds } from './images.js';
import { fetchHistoryAfter, fetchHistoryBefore, fetchReplies, fromStored, storeMessages } from './slack-messages.js';
import { getUserNames } from './users.js';

export interface RenderedThreadContext {
  /**
   * Parent + the newest replies that fit the history budget (window.ts; with `[k earlier replies not shown…]` saying
   * how much of that the summary covers), author-labelled, truncated, file/image placeholders.
   */
  history: string;
  /** Rolling summary of the replies not shown (summary.ts), when it covers any of them. */
  summary?: string;
  /** ~5 channel messages around the thread parent. Empty for DMs. */
  channelContext: string;
  /** The turn's new messages rendered the same way. */
  newMessages: string;
  /** Human authors of the shown thread messages + new messages, most recent first, unique (bots excluded). */
  participantIds?: string[];
}

const CHANNEL_BEFORE = Math.max(1, limits.contextChannelMessages - 2);
const CHANNEL_AFTER = limits.contextChannelMessages - CHANNEL_BEFORE;
const HISTORY_CHARS = limits.messageTruncateTokens * 4;
const CHANNEL_CHARS = limits.channelMessageTruncateTokens * 4;
const NEW_CHARS = limits.newMessageTruncateTokens * 4;
const READ_CHARS = limits.readMessageTruncateTokens * 4;
const HISTORY_BUDGET_CHARS = limits.historyTokens * 4;

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

/**
 * Pull the thread (and channel context around its parent) from Slack into `messages`, once per thread. All Slack
 * reads run in parallel. `rootIsNew`: the thread's parent is one of the turn's new messages (a fresh DM or a
 * top-level mention), which the pipeline already stored, so there are no replies to fetch.
 */
export async function backfillThread(thread: ThreadRow, opts: { rootIsNew?: boolean } = {}): Promise<void> {
  if (thread.backfilled) return;
  const replies = opts.rootIsNew
    ? Promise.resolve()
    : fetchReplies(thread.channelId, thread.threadTs).then((r) => storeMessages(thread.channelId, thread.id, r));
  const channel = thread.isDm
    ? Promise.resolve()
    : Promise.all([
        // Over-fetch: joins/leaves are dropped when stored.
        fetchHistoryBefore(thread.channelId, { latest: thread.threadTs, limit: CHANNEL_BEFORE + 7 }),
        CHANNEL_AFTER > 0 ? fetchHistoryAfter(thread.channelId, thread.threadTs, CHANNEL_AFTER) : Promise.resolve([]),
      ])
        .then(([before, after]) => storeMessages(thread.channelId, null, [...before, ...after]))
        .catch((err) => log.warn({ err, threadId: thread.id }, 'channel context backfill failed'));
  const [r] = await Promise.allSettled([replies, channel]);
  if (r.status === 'rejected') {
    // Transient failures retry on the next turn; the context still renders from whatever is stored.
    log.warn({ err: r.reason, threadId: thread.id }, 'thread backfill failed');
    return;
  }
  await sql`update threads set backfilled = true where id = ${thread.id}`;
  thread.backfilled = true;
}

async function loadThreadMessages(thread: ThreadRow): Promise<RenderMsg[]> {
  // The root by ts too: a group-ping message the bot answered in a new top-level thread is stored under that thread.
  const rows = await sql<StoredMessage[]>`select * from messages
    where (thread_id = ${thread.id} or (channel_id = ${thread.channelId} and ts = ${thread.threadTs})) and not deleted`;
  return withButtons(thread.id, rows.map(fromStored));
}

/**
 * Quick-reply buttons (table reply_buttons, written by the agent's reply tool / the press handler): the bot message
 * that offered them gets `buttons` (labels + who pressed what), the press itself (a stored synthetic message) is
 * marked `viaButton`.
 */
export async function withButtons(threadId: string, msgs: RenderMsg[]): Promise<RenderMsg[]> {
  if (!msgs.length) return msgs;
  const rows = await sql<{ messageTs: string | null; labels: string[]; pressedBy: string | null; pressedLabel: string | null; pressedMessageTs: string | null }[]>`
    select message_ts, labels, pressed_by, pressed_label, pressed_message_ts from reply_buttons
    where thread_id = ${threadId} and message_ts is not null order by id`;
  if (!rows.length) return msgs;
  const offered = new Map(rows.map((r) => [r.messageTs!, r]));
  const presses = new Set(rows.map((r) => r.pressedMessageTs).filter(Boolean));
  return msgs.map((m) => {
    const b = offered.get(m.ts);
    const out = b ? { ...m, buttons: { labels: Array.isArray(b.labels) ? b.labels : [], pressedBy: b.pressedBy, pressedLabel: b.pressedLabel } } : m;
    return presses.has(m.ts) && !m.botId ? { ...out, viaButton: true } : out;
  });
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
export async function formatEnvFor(threadId: string, msgs: RenderMsg[], maxChars = HISTORY_CHARS): Promise<FormatEnv> {
  const [names, imageIds, self] = await Promise.all([
    getUserNames(userIdsIn(msgs)),
    assignImageIds(threadId, msgs),
    getBotIdentity().catch(() => undefined),
  ]);
  return { names, imageIds, self: { ...self, name: env.BOT_DISPLAY_NAME }, maxChars };
}

/**
 * Render a thread for a front-agent turn. Backfills from conversations.replies on first use of a thread
 * (threads.backfilled), and assigns stable `img_N` ids to images (thread_images).
 */
export async function renderThreadContext(threadId: string, opts: { newMessageTs: string[]; timing?: TurnTiming }): Promise<RenderedThreadContext> {
  const span = <T,>(name: string, fn: () => Promise<T>) => (opts.timing ? opts.timing.span(name, fn) : fn());
  const thread = await span('ctx_ensure_thread', () => ensureThread(threadId));
  await span('ctx_backfill', () => backfillThread(thread, { rootIsNew: opts.newMessageTs.includes(thread.threadTs) }));

  const [all, summary] = await Promise.all([
    span('ctx_load_thread', () => loadThreadMessages(thread)),
    span('ctx_summary', () => loadThreadSummary(threadId)).catch((err) => (log.warn({ err, threadId }, 'loadThreadSummary failed'), null)),
  ]);
  const newSet = new Set(opts.newMessageTs);
  // New messages may live outside the thread rows (e.g. a top-level DM message) — load them by ts too.
  const newMsgs = opts.newMessageTs.length ? await span('ctx_load_new', () => loadByTs(thread.channelId, opts.newMessageTs).then((m) => withButtons(threadId, m))) : [];
  const newest = newMsgs.reduce<string | undefined>((acc, m) => (!acc || compareTs(m.ts, acc) > 0 ? m.ts : acc), undefined);
  // History = everything before the turn's newest message, minus the new messages themselves. Anything newer
  // arrives via the inbox (renderMessages), so it would be duplicated here.
  const history = all.filter((m) => !newSet.has(m.ts) && (!newest || compareTs(m.ts, newest) < 0 || m.ts === thread.threadTs));
  const win = planHistoryWindow(history, thread.threadTs, {
    coveredTs: summary?.coveredTs,
    maxChars: HISTORY_BUDGET_CHARS,
    maxCount: limits.contextReplies,
    size: (m) => estimateRenderedChars(m, HISTORY_CHARS),
    compactAt: limits.threadSummaryCompactAt,
    keepFraction: limits.threadSummaryKeep,
  });
  // Background summary update; never blocks the turn (the job is idempotent per target).
  if (win.compactTo) requestThreadSummary(threadId, win.compactTo).catch((err) => log.warn({ err, threadId }, 'thread summary enqueue failed'));
  const channelMsgs = thread.isDm ? [] : await span('ctx_channel', () => loadChannelContext(thread));

  const shown = [...(win.parent ? [win.parent] : []), ...win.replies, ...newMsgs, ...channelMsgs];
  const fenv = await span('ctx_format_env', () => formatEnvFor(threadId, shown));
  const sel = fitRendered(win, fenv);
  return {
    history: formatThread(sel, fenv),
    ...(summary && sel.summarised > 0 ? { summary: summary.summary } : {}),
    channelContext: formatMessages(channelMsgs, { ...fenv, maxChars: CHANNEL_CHARS }),
    newMessages: formatMessages(newMsgs, { ...fenv, maxChars: NEW_CHARS }),
    participantIds: authorsMostRecentFirst([...(sel.parent ? [sel.parent] : []), ...sel.replies, ...newMsgs]),
  };
}

/**
 * The window is planned on estimated sizes; if the real rendering is still over the budget, drop the oldest shown
 * replies (counted as omitted and not yet summarised), so the section never needs clipping and the omitted note
 * stays exact.
 */
function fitRendered(win: HistoryWindow, fenv: FormatEnv): HistoryWindow {
  let sel = win;
  while (sel.replies.length > 1 && formatThread(sel, fenv).length > HISTORY_BUDGET_CHARS) {
    sel = { ...sel, replies: sel.replies.slice(1), omitted: sel.omitted + 1, unsummarised: sel.unsummarised + 1 };
  }
  return sel;
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
  const msgs = await withButtons(threadId, await loadByTs(channelId, ts));
  const fenv = await formatEnvFor(threadId, msgs, NEW_CHARS);
  return formatMessages(msgs, fenv);
}

/** Render raw Slack API messages (read_thread / read_channel) in the context format; registers their images. */
export async function renderRawMessages(threadId: string, msgs: RenderMsg[]): Promise<string> {
  await ensureThread(threadId);
  const fenv = await formatEnvFor(threadId, msgs, READ_CHARS);
  return formatMessages(msgs, fenv);
}
