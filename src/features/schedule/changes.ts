/** Pure change detection for watches: page text snapshots + line diff, new web results, new Slack matches, judge parsing. */
import { createHash } from 'node:crypto';

/** Max characters of normalized page text kept as the snapshot. */
export const SNAPSHOT_MAX_CHARS = 60_000;

/** Page text → stable snapshot: lines trimmed, inner whitespace collapsed, empty lines dropped, capped. */
export function normalizePageText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let out = lines.join('\n');
  if (out.length > SNAPSHOT_MAX_CHARS) out = out.slice(0, SNAPSHOT_MAX_CHARS);
  return out;
}

export const hashText = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Lines added / removed between two snapshots (set semantics: moved or duplicated lines are not changes). Order
 * follows the respective snapshot.
 */
export function diffLines(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return { added: uniq(newLines.filter((l) => !oldSet.has(l))), removed: uniq(oldLines.filter((l) => !newSet.has(l))) };
}

/** Lines prefixed with `prefix`, as many as fit in `maxChars`, plus a "[n more]" note. */
export function clipLines(lines: string[], prefix: string, maxChars: number): string {
  const out: string[] = [];
  let len = 0;
  for (const l of lines) {
    const s = `${prefix}${l.length > 500 ? `${l.slice(0, 500)}…` : l}`;
    if (out.length && len + s.length + 1 > maxChars) break;
    out.push(s);
    len += s.length + 1;
  }
  if (out.length < lines.length) out.push(`[${lines.length - out.length} more lines]`);
  return out.join('\n');
}

/** Human-readable page diff for the judge and the notification turn. Empty when nothing changed. */
export function renderPageDiff(url: string, d: { added: string[]; removed: string[] }, maxChars = 6000): string {
  if (!d.added.length && !d.removed.length) return '';
  const parts = [`Page: ${url}`];
  if (d.added.length) parts.push(`New or changed lines:\n${clipLines(d.added, '+ ', Math.floor(maxChars * 0.7))}`);
  if (d.removed.length) parts.push(`Removed or replaced lines:\n${clipLines(d.removed, '- ', Math.floor(maxChars * 0.3))}`);
  return parts.join('\n\n');
}

/** URLs not seen before (order kept, deduped). */
export function newUrls(seen: readonly string[], urls: readonly string[]): string[] {
  const s = new Set(seen);
  return [...new Set(urls)].filter((u) => !s.has(u));
}

/** Seen URLs after a check: newest first, capped. */
export function mergeSeen(seen: readonly string[], urls: readonly string[], cap = 200): string[] {
  return [...new Set([...urls, ...seen])].slice(0, cap);
}

/**
 * The numbered result blocks of a web_search text output whose URL is in `urls` (format of formatExaResults:
 * "N. title\n   url\n   > highlight", blocks separated by blank lines).
 */
export function pickWebResultBlocks(text: string, urls: readonly string[]): string[] {
  const want = new Set(urls);
  return text
    .split(/\n\n(?=\d+\. )/)
    .map((b) => b.split(/\n\n/)[0]!.replace(/<\/?untrusted_content[^>]*>/g, '').trim())
    .filter((b) => /^\d+\. /.test(b))
    .filter((b) => b.split('\n').some((l) => want.has(l.trim())));
}

const tsNum = (ts: unknown) => (typeof ts === 'string' && /^\d+(\.\d+)?$/.test(ts) ? Number(ts) : NaN);

/** Max ts of a list (as a Slack ts string), or `fallback`. */
export function maxTs(tss: unknown[], fallback: string): string {
  let best = fallback;
  for (const t of tss) {
    const n = tsNum(t);
    if (!Number.isNaN(n) && (Number.isNaN(tsNum(best)) || n > tsNum(best))) best = t as string;
  }
  return best;
}

/**
 * Slack search matches that are new for a watch: newer than `sinceTs`, not by the owner, not from bots (the bot's
 * own notifications would match the query again), not in the watch's own thread.
 */
export function newSlackMatches(matches: any[], opts: { sinceTs: string; ownerId: string; channelId: string; threadTs: string }): any[] {
  const since = tsNum(opts.sinceTs);
  return matches.filter((m) => {
    if (!(tsNum(m?.ts) > since)) return false;
    if (m.user === opts.ownerId) return false;
    if (m.bot_id || m.subtype === 'bot_message' || m.bot_profile) return false;
    if (m.channel?.id === opts.channelId) {
      const root = typeof m.thread_ts === 'string' ? m.thread_ts : /[?&]thread_ts=([\d.]+)/.exec(String(m.permalink ?? ''))?.[1];
      if (m.ts === opts.threadTs || root === opts.threadTs) return false;
    }
    return true;
  });
}

/** Judge output: first line YES/NO, then a short summary. Anything unparseable counts as not meaningful. */
export function parseJudge(text: string): { meaningful: boolean; summary: string } {
  const t = text.trim();
  const first = t.split('\n')[0]!.toLowerCase().replace(/^[^a-z]+/, '');
  const meaningful = first.startsWith('yes');
  const summary = t
    .split('\n')
    .slice(1)
    .join(' ')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();
  return { meaningful, summary: summary.slice(0, 500) };
}
