import { describe, expect, it } from 'vitest';
import { formatSubagentResult, type ResultRun, type ResultSubagent } from './subagent-result.js';

const sa: ResultSubagent = { id: 'sa_1', title: 'Run the benchmark', status: 'idle', ownerId: 'U1', kind: 'model', sandbox: true, summary: 'benchmarked' };
const run = (over: Partial<ResultRun>): ResultRun => ({
  id: 1,
  status: 'complete',
  instructions: 'run it',
  result: 'all good',
  error: null,
  details: null,
  isResume: false,
  finishedAt: null,
  ...over,
});

describe('formatSubagentResult', () => {
  it('shows the latest finished run in full, with its files, and earlier runs in one line', () => {
    const files = new Map([[2, [{ id: 'file_a', name: 'out.csv', mime: 'text/csv', size: 10, description: null }]]]);
    const text = formatSubagentResult(sa, [run({ id: 2, result: 'line one\nline two', isResume: true }), run({ id: 1, result: 'first take' })], files);
    expect(text).toContain('sa_1 "Run the benchmark" [sandbox] (owner <@U1>) — subagent idle');
    expect(text).toContain('Latest finished run (follow-up) — COMPLETE');
    expect(text).toContain('Result:\nline one\nline two');
    expect(text).toContain('- file_a: out.csv');
    expect(text).toContain('Earlier runs (newest first):\n- complete: first take');
  });

  it('a run in progress is reported, with the previous result still shown', () => {
    const text = formatSubagentResult({ ...sa, status: 'running' }, [run({ id: 3, status: 'running', details: 'installing deps' }), run({ id: 2, result: 'v1' })], new Map());
    expect(text).toContain('A run is running: installing deps');
    expect(text).toContain('Result:\nv1');
  });

  it('failed and cancelled runs, no runs, and clipping of a long result', () => {
    expect(formatSubagentResult(sa, [run({ status: 'error', error: 'boom', result: null })], new Map())).toContain('Failed: boom');
    expect(formatSubagentResult(sa, [run({ status: 'cancelled' })], new Map())).toContain('Cancelled before finishing.');
    expect(formatSubagentResult(sa, [], new Map())).toContain('Summary: benchmarked');
    const long = formatSubagentResult(sa, [run({ result: 'word '.repeat(5000) })], new Map(), 100);
    expect(long).toContain('result truncated here');
    expect(long.length).toBeLessThan(2000);
  });
});
