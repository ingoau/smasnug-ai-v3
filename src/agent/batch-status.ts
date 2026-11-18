/**
 * Batch status of the subagents one request started (the runs on one plan card), as one or two lines for the front
 * agent. Prod: a request for 1000 names spawned 10 subagents, 3 failed (timed out), and the write-up delivered 688
 * names with only a vague note. The per-run sections of <finished_subagents> did list the failures, but buried among
 * ten results; this puts the count and every missing part on top, with what to do about it. Rendering is pure
 * (batch-status.test.ts); `loadOpenBatches` finds the batches still in play for non-results turns.
 */
import { sql } from '../db/index.js';
import { oneLine } from './util.js';

export interface BatchRun {
  id: number;
  subagentId: string;
  title: string;
  status: string;
  error: string | null;
  /** This run was itself a retry: a follow-up run (message_subagent, is_resume) or the subagent failed before. */
  retry?: boolean;
}

const ACTIVE = new Set(['queued', 'running']);

/** Latest run per subagent (a retry on the same card supersedes the failed run), in first-spawn order. */
export function latestPerSubagent(runs: BatchRun[]): BatchRun[] {
  const by = new Map<string, BatchRun>();
  // Sorted by id: a later run overwrites the entry but keeps the subagent's original position.
  for (const r of [...runs].sort((a, b) => a.id - b.id)) by.set(r.subagentId, r);
  return [...by.values()];
}

const name = (r: BatchRun) => `${r.subagentId} "${oneLine(r.title, 40)}"`;

/**
 * '' for a single subagent that completed (nothing to flag). `final`: the results turn (every run is terminal).
 * Otherwise the batch is still in play (some still running; their results come in a results turn).
 */
export function renderBatchStatus(runs: BatchRun[], opts: { final: boolean; label?: string }): string {
  const label = opts.label ?? 'Subagents for this request';
  const latest = latestPerSubagent(runs);
  const total = latest.length;
  if (total === 0) return '';
  const done = latest.filter((r) => r.status === 'complete');
  const failed = latest.filter((r) => r.status === 'error');
  const cancelled = latest.filter((r) => r.status === 'cancelled');
  const running = latest.filter((r) => ACTIVE.has(r.status));
  if (done.length === total) return total > 1 ? `${label}: all ${total} finished with results.` : '';
  const bits = [`${label}: ${done.length} of ${total} finished with results`];
  if (failed.length) bits.push(`FAILED: ${failed.map((r) => `${name(r)} (${oneLine(r.error ?? 'unknown error', 80)})`).join(', ')}`);
  if (cancelled.length) bits.push(`cancelled: ${cancelled.map(name).join(', ')}`);
  // Running ones are named in <subagents> already: a count is enough.
  if (running.length) bits.push(`${running.length} still running`);
  const line = `${bits.join('; ')}.`;
  if (!opts.final) return failed.length ? `${line} (Results, failures included, come in a results turn.)` : line;
  const missing = failed.length + cancelled.length;
  // A part that already failed on a retry isn't retried again (message_subagent puts the retry on a new card, so it
  // would come back here as a fresh failure): only the disclosure advice for it.
  const retryable = failed.filter((r) => !r.retry);
  const retriedNote = retryable.length && retryable.length < failed.length
    ? ` (${failed.filter((r) => r.retry).map((r) => r.subagentId).join(', ')} already failed on a retry: don't retry ${failed.length - retryable.length === 1 ? 'it' : 'them'} again)`
    : '';
  const advice = retryable.length
    ? `Their parts are MISSING from the results. Retry each failed part once${retriedNote} (message_subagent to it, or a new spawn_subagent), or tell the speaker exactly what is missing and how much (e.g. "3 of 10 parts, about 300 of 1000 names"); never present partial results as complete.`
    : `${missing === 1 ? 'Its part is' : 'Their parts are'} missing from the results${failed.length ? ' (already retried; don\'t retry again)' : ''}: tell the speaker exactly what is missing and how much; never present partial results as complete.`;
  return `${line} ${advice}`;
}

const ago = (d: Date) => {
  const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

/**
 * Batches still in play in a thread for a non-results turn: cards with runs whose results turn hasn't happened yet
 * (not synthesized), newest first, recent only. Each rendered with `renderBatchStatus(final: false)`, labelled as an
 * earlier request (it may not be the one this turn is about). A batch of one subagent still running without
 * failures is skipped: <subagents> lists it already.
 */
export async function renderOpenBatches(threadId: string, maxCards = 2): Promise<string> {
  const cards = await sql<{ id: number; createdAt: Date; authorId: string | null }[]>`
    select c.id, c.created_at, t.author_id from cards c left join turns t on t.id = c.turn_id
    where c.thread_id = ${threadId} and not c.synthesized and c.created_at > now() - interval '1 day'
      and exists (select 1 from runs r where r.card_id = c.id)
    order by c.id desc limit ${maxCards}`;
  const lines: string[] = [];
  for (const c of cards) {
    const rows = await sql<(BatchRun & { retry: boolean })[]>`
      select r.id, r.subagent_id, s.title, r.status, r.error, (r.is_resume or exists (select 1 from runs p where p.subagent_id = r.subagent_id and p.id < r.id and p.status = 'error')) as retry
      from runs r join subagents s on s.id = r.subagent_id
      where r.card_id = ${Number(c.id)} order by r.id`;
    const runs = rows.map((r) => ({ ...r, id: Number(r.id) }));
    const latest = latestPerSubagent(runs);
    if (latest.length === 1 && ACTIVE.has(latest[0]!.status) && !runs.some((r) => r.status === 'error')) continue;
    const label = `Earlier request (${[c.authorId ? `<@${c.authorId}>` : null, ago(new Date(c.createdAt))].filter(Boolean).join(', ')})`;
    const line = renderBatchStatus(runs, { final: false, label });
    if (line) lines.push(line);
  }
  return lines.join('\n');
}
