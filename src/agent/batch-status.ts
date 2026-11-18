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
export function renderBatchStatus(runs: BatchRun[], opts: { final: boolean }): string {
  const latest = latestPerSubagent(runs);
  const total = latest.length;
  if (total === 0) return '';
  const done = latest.filter((r) => r.status === 'complete');
  const failed = latest.filter((r) => r.status === 'error');
  const cancelled = latest.filter((r) => r.status === 'cancelled');
  const running = latest.filter((r) => ACTIVE.has(r.status));
  if (done.length === total) return total > 1 ? `Subagents for this request: all ${total} finished with results.` : '';
  const bits = [`Subagents for this request: ${done.length} of ${total} finished with results`];
  if (failed.length) bits.push(`FAILED: ${failed.map((r) => `${name(r)} (${oneLine(r.error ?? 'unknown error', 80)})`).join(', ')}`);
  if (cancelled.length) bits.push(`cancelled: ${cancelled.map(name).join(', ')}`);
  // Running ones are named in <subagents> already: a count is enough.
  if (running.length) bits.push(`${running.length} still running`);
  const line = `${bits.join('; ')}.`;
  if (!opts.final) return failed.length ? `${line} (Results, failures included, come in a results turn.)` : line;
  const missing = failed.length + cancelled.length;
  const advice = failed.length
    ? `Their parts are MISSING from the results. Retry each failed part once (message_subagent to it, or a new spawn_subagent), or tell the speaker exactly what is missing and how much (e.g. "3 of 10 parts, about 300 of 1000 names"); never present partial results as complete.`
    : `${missing === 1 ? 'Its part is' : 'Their parts are'} missing from the results: tell the speaker exactly what is missing and how much; never present partial results as complete.`;
  return `${line} ${advice}`;
}

/**
 * Batches still in play in a thread for a non-results turn: cards with runs whose results turn hasn't happened yet
 * (not synthesized), newest first, recent only. Each rendered with `renderBatchStatus(final: false)`.
 */
export async function renderOpenBatches(threadId: string, maxCards = 2): Promise<string> {
  const cards = await sql<{ id: number }[]>`
    select c.id from cards c where c.thread_id = ${threadId} and not c.synthesized and c.created_at > now() - interval '1 day'
      and exists (select 1 from runs r where r.card_id = c.id)
    order by c.id desc limit ${maxCards}`;
  const lines: string[] = [];
  for (const c of cards) {
    const runs = await sql<BatchRun[]>`
      select r.id, r.subagent_id, s.title, r.status, r.error from runs r join subagents s on s.id = r.subagent_id
      where r.card_id = ${Number(c.id)} order by r.id`;
    const line = renderBatchStatus(
      runs.map((r) => ({ ...r, id: Number(r.id) })),
      { final: false },
    );
    if (line) lines.push(line);
  }
  return lines.join('\n');
}
