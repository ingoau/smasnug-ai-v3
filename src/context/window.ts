/**
 * Pure selection of the thread history window for the front agent's prompt, and when to move the rolling summary
 * (summary.ts) forward. No I/O; unit-tested in window.test.ts.
 *
 * The window is the replies after the summary's covered ts, as long as they fit the history budget (size and count,
 * parent always included). Once they grow past `compactAt` of the budget, the summary is asked to advance to a ts
 * that leaves only `keepFraction` of the budget shown (hysteresis, like compaction in coding tools): between
 * compactions the shown history only grows at its end (stable prefix for prompt caching), and in steady state the
 * summary covers exactly the replies not shown. When the replies after the summary don't fit (a burst, or a long
 * thread the bot just joined) the newest replies that fit are shown and the gap is reported as `unsummarised`
 * until the background update lands.
 */
import { compareTs, type RenderMsg, type ThreadSelection } from './format.js';
import { takeWithinBudget } from '../tools/paging.js';

export interface WindowOptions {
  /** Newest reply ts the summary covers (undefined: no summary yet). */
  coveredTs?: string;
  /** History budget in chars (parent included). */
  maxChars: number;
  /** Max replies shown. */
  maxCount: number;
  /** Estimated rendered size of one message, in chars. */
  size: (m: RenderMsg) => number;
  /** Ask for a summary update once the replies after the summary use more than this fraction of the budget (size or count). */
  compactAt: number;
  /** A summary update leaves this fraction of the budget (size and count) shown. */
  keepFraction: number;
}

export interface HistoryWindow extends ThreadSelection {
  /** Of the omitted replies, how many the summary covers (ts ≤ coveredTs) and how many it doesn't yet. */
  summarised: number;
  unsummarised: number;
  /** Set when the summary should advance: summarise every reply up to and including this ts. */
  compactTo?: string;
}

/** Parent + the replies to show (oldest first), the omitted counts, and where the summary should move to. */
export function planHistoryWindow(msgs: RenderMsg[], rootTs: string, opts: WindowOptions): HistoryWindow {
  const live = msgs.filter((m) => !m.deleted).sort((a, b) => compareTs(a.ts, b.ts));
  const parent = live.find((m) => m.ts === rootTs);
  const replies = live.filter((m) => m.ts !== rootTs);
  const reserved = parent ? opts.size(parent) : 0;
  const covered = opts.coveredTs;
  const isCovered = (m: RenderMsg) => covered !== undefined && compareTs(m.ts, covered) <= 0;

  const after = replies.filter((m) => !isCovered(m));
  const afterChars = after.reduce((n, m) => n + opts.size(m), 0);
  const fits = after.length <= opts.maxCount && reserved + afterChars <= opts.maxChars;
  // Not fitting: the newest replies that do (a suffix of `after`, so never a reply the summary already covers).
  const shown = fits ? after : takeWithinBudget(after, 'backward', { maxChars: opts.maxChars, maxCount: opts.maxCount, size: opts.size, reserved });

  const omitted = replies.length - shown.length;
  const summarised = replies.filter(isCovered).length;
  const out: HistoryWindow = { ...(parent ? { parent } : {}), replies: shown, omitted, summarised, unsummarised: omitted - summarised };

  const overSize = reserved + afterChars > opts.maxChars * opts.compactAt;
  const overCount = after.length > opts.maxCount * opts.compactAt;
  if (after.length && (overSize || overCount)) {
    const keep = takeWithinBudget(after, 'backward', {
      maxChars: Math.max(1, Math.floor(opts.maxChars * opts.keepFraction)),
      maxCount: Math.max(1, Math.floor(opts.maxCount * opts.keepFraction)),
      size: opts.size,
      reserved,
    });
    const firstKept = after.indexOf(keep[0]!);
    if (firstKept > 0) out.compactTo = after[firstKept - 1]!.ts;
  }
  return out;
}
