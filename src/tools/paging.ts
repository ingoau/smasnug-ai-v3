/**
 * Pure paging for read_thread / read_channel: pages are capped by size (≈tokens, ~4 chars each) as well as by
 * message count, and always hold at least one message. No I/O; unit-tested in paging.test.ts.
 */
import { compareTs, type RenderMsg } from '../context/format.js';

/** Rough rendered size of one message line (text capped at `maxChars` as formatMessage does, plus label overhead). */
export function estimateRenderedChars(m: RenderMsg, maxChars: number): number {
  const text = Math.min((m.text ?? '').length, maxChars + 12);
  const files = (m.files ?? []).reduce((n, f) => n + 30 + (f.name?.length ?? 4), 0);
  const reactions = (m.reactions?.length ?? 0) * 25;
  const attachments = (m.attachments ?? []).reduce((n, a) => n + 40 + Math.min((a.text?.length ?? 0) + (a.title?.length ?? 0), a.kind === 'link' ? 400 : 1500) + (a.url?.length ?? 0), 0);
  return 60 + text + files + reactions + attachments;
}

/** Take messages from the start (`'forward'`) or the end (`'backward'`) of `msgs` until the budget or count runs out; at least one. */
export function takeWithinBudget<T>(msgs: T[], from: 'forward' | 'backward', opts: { maxChars: number; maxCount?: number; size: (m: T) => number; reserved?: number }): T[] {
  const out: T[] = [];
  let used = opts.reserved ?? 0;
  const order = from === 'forward' ? msgs : [...msgs].reverse();
  for (const m of order) {
    if (opts.maxCount !== undefined && out.length >= opts.maxCount) break;
    const s = opts.size(m);
    if (out.length > 0 && used + s > opts.maxChars) break;
    out.push(m);
    used += s;
  }
  return from === 'forward' ? out : out.reverse();
}

export interface ThreadPage {
  parent?: RenderMsg;
  /** Replies on this page, oldest first. */
  replies: RenderMsg[];
  /** 1-based position of the first/last reply on the page among all replies (0 when the page has none). */
  from: number;
  to: number;
  total: number;
  /** Cursor for the previous (older) page, if there is one. */
  olderTs?: string;
  /** Cursor for the next (newer) page, if there is one. */
  newerTs?: string;
}

/**
 * One page of a thread. `before` pages backwards (the newest replies before it; default: from the newest),
 * `after` pages forwards (the oldest replies after it; pass the thread ts to read from the start). Both can be
 * combined to read a range forwards. The parent is shown when the page reaches the start of the thread.
 */
export function pageThread(
  msgs: RenderMsg[],
  rootTs: string,
  opts: { before?: string; after?: string; limit?: number; maxChars: number; size: (m: RenderMsg) => number },
): ThreadPage {
  const sorted = [...msgs].sort((a, b) => compareTs(a.ts, b.ts));
  const parent = sorted.find((m) => m.ts === rootTs);
  const replies = sorted.filter((m) => m.ts !== rootTs);
  const total = replies.length;
  const inRange = replies.filter((m) => (!opts.before || compareTs(m.ts, opts.before) < 0) && (!opts.after || compareTs(m.ts, opts.after) > 0));
  const forward = opts.after !== undefined;
  // Reading forward from the very start shows the parent first: count it against the page.
  const startsAtTop = forward && inRange.length > 0 && inRange[0] === replies[0];
  const reserved = startsAtTop && parent ? opts.size(parent) : 0;
  const page = inRange.length ? takeWithinBudget(inRange, forward ? 'forward' : 'backward', { maxChars: opts.maxChars, maxCount: opts.limit, size: opts.size, reserved }) : [];
  if (!page.length) {
    // Nothing in range: show the parent when the range reaches back to it (e.g. a thread with no replies yet).
    const reachesTop = !opts.after || compareTs(opts.after, rootTs) <= 0;
    const showParent = reachesTop && parent && (!opts.before || compareTs(rootTs, opts.before) < 0) ? parent : undefined;
    return { ...(showParent ? { parent: showParent } : {}), replies: [], from: 0, to: 0, total };
  }
  const first = replies.indexOf(page[0]!);
  const last = replies.indexOf(page[page.length - 1]!);
  return {
    ...(first === 0 && parent ? { parent } : {}),
    replies: page,
    from: first + 1,
    to: last + 1,
    total,
    ...(first > 0 ? { olderTs: page[0]!.ts } : {}),
    ...(last < total - 1 ? { newerTs: page[page.length - 1]!.ts } : {}),
  };
}

/** The page header: position and how to continue. */
export function threadPageHeader(p: ThreadPage, tool = 'read_thread'): string {
  const of = `${p.total} ${p.total === 1 ? 'reply' : 'replies'}`;
  const pos = p.replies.length
    ? `${p.parent ? 'parent + ' : ''}replies ${p.from}–${p.to} of ${of}`
    : p.parent
      ? `parent only (${of})`
      : `no replies in that range (${of} in total)`;
  const nav = [
    p.olderTs ? `older: ${tool} before_ts=${p.olderTs}` : p.replies.length ? 'start of thread' : '',
    p.newerTs ? `newer: ${tool} after_ts=${p.newerTs}` : p.replies.length ? 'newest reply' : '',
  ].filter(Boolean);
  return `[${[pos, ...nav].join('; ')}]`;
}

/**
 * Trim a window centred on `centerTs` to the size budget: drop messages from whichever side has more left until it
 * fits (the centre message always stays).
 */
export function trimAround<T extends { ts: string }>(msgs: T[], centerTs: string, opts: { maxChars: number; size: (m: T) => number }): T[] {
  let out = [...msgs];
  let total = out.reduce((n, m) => n + opts.size(m), 0);
  while (out.length > 1 && total > opts.maxChars) {
    const c = out.findIndex((m) => m.ts === centerTs);
    const center = c >= 0 ? c : Math.floor(out.length / 2);
    const before = center;
    const after = out.length - 1 - center;
    const drop = after > before ? out.length - 1 : 0;
    total -= opts.size(out[drop]!);
    out = out.filter((_, i) => i !== drop);
  }
  return out;
}

export interface ChannelPageInfo {
  /** Messages on the page, oldest first. */
  msgs: { ts: string }[];
  /** Whether older / newer messages may exist beyond the page (false: start of channel / newest message). */
  hasOlder: boolean;
  hasNewer: boolean;
}

/**
 * Header for a page of top-level channel messages (channel totals aren't known, so the position is the ts range),
 * with how to continue in both directions. `call` is how to call the tool again, e.g. `read_channel` or
 * `read_public_channel channel=C123`.
 */
export function channelPageHeader(p: ChannelPageInfo, call: string): string {
  if (!p.msgs.length) return '[no messages on this page]';
  const n = p.msgs.length;
  const first = p.msgs[0]!.ts;
  const last = p.msgs[n - 1]!.ts;
  const pos = `${n} top-level ${n === 1 ? 'message' : 'messages'}, oldest first, ${n === 1 ? first : `${first} to ${last}`}`;
  const nav = [p.hasOlder ? `older: ${call} before_ts=${first}` : 'start of channel', p.hasNewer ? `newer: ${call} after_ts=${last}` : 'newest message'];
  return `[${[pos, ...nav].join('; ')}]`;
}
