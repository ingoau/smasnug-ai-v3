import { describe, expect, it } from 'vitest';
import { latestPerSubagent, renderBatchStatus, type BatchRun } from './batch-status.js';

const run = (id: number, status: string, error: string | null = null, subagentId = `sa_${id}`): BatchRun => ({ id, subagentId, title: `Names part ${id}`, status, error });

describe('renderBatchStatus', () => {
  it('is empty for no runs and for one completed subagent', () => {
    expect(renderBatchStatus([], { final: true })).toBe('');
    expect(renderBatchStatus([run(1, 'complete')], { final: true })).toBe('');
  });

  it('confirms a fully completed batch in one short line', () => {
    expect(renderBatchStatus([run(1, 'complete'), run(2, 'complete')], { final: true })).toBe('Subagents for this request: all 2 finished with results.');
  });

  it('results turn: counts, names every failure with its error, and says to retry or disclose', () => {
    const runs = [...Array.from({ length: 7 }, (_, i) => run(i + 1, 'complete')), run(8, 'error', 'Timed out after 10 min'), run(9, 'error', 'Worker stopped'), run(10, 'cancelled')];
    const s = renderBatchStatus(runs, { final: true });
    expect(s).toMatch(/^Subagents for this request: 7 of 10 finished with results; FAILED: sa_8 "Names part 8" \(Timed out after 10 min\), sa_9 "Names part 9" \(Worker stopped\); cancelled: sa_10 "Names part 10"\./);
    expect(s).toContain('Retry each failed part once');
    expect(s).toContain('never present partial results as complete');
    expect(s.split('\n')).toHaveLength(1);
  });

  it('results turn with only cancellations: disclose, no retry advice', () => {
    const s = renderBatchStatus([run(1, 'complete'), run(2, 'cancelled')], { final: true });
    expect(s).toContain('cancelled: sa_2');
    expect(s).not.toContain('Retry');
    expect(s).toContain('never present partial results as complete');
  });

  it('batch in play: running ones as a count, failures flagged as coming in the results turn', () => {
    expect(renderBatchStatus([run(1, 'complete'), run(2, 'running'), run(3, 'queued')], { final: false })).toBe(
      'Subagents for this request: 1 of 3 finished with results; 2 still running.',
    );
    const s = renderBatchStatus([run(1, 'error', 'boom'), run(2, 'running')], { final: false });
    expect(s).toContain('FAILED: sa_1 "Names part 1" (boom)');
    expect(s).toContain('results turn');
    expect(s).not.toContain('Retry');
  });

  it('a later run of the same subagent on the card (a retry) supersedes its failed run', () => {
    const runs = [run(1, 'error', 'boom', 'sa_a'), run(2, 'complete', null, 'sa_b'), run(3, 'complete', null, 'sa_a')];
    expect(latestPerSubagent(runs).map((r) => [r.subagentId, r.id])).toEqual([
      ['sa_a', 3],
      ['sa_b', 2],
    ]);
    expect(renderBatchStatus(runs, { final: true })).toBe('Subagents for this request: all 2 finished with results.');
  });
});
