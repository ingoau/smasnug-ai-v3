/** DeferredQueue: background jobs of a subagent run (queued Slack searches), delivered at step boundaries. */
import { describe, expect, it } from 'vitest';
import { DeferredQueue } from './deferred.js';

const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe('DeferredQueue', () => {
  it('runs jobs in the background and hands finished results over once', async () => {
    const q = new DeferredQueue(4);
    expect(q.defer({ label: 'a', run: () => later(20, 'A results') })).toBe('S1');
    expect(q.defer({ label: 'b', run: () => later(200, 'B results') })).toBe('S2');
    expect(q.take()).toBeNull();
    expect(q.outstanding).toBe(2);
    await q.waitAny(1000);
    expect(q.take()).toBe('[Background search S1: "a"]\nA results');
    expect(q.take()).toBeNull();
    expect(q.pendingLabels()).toEqual(['S2 "b"']);
    await q.waitAll(1000);
    expect(q.take()).toBe('[Background search S2: "b"]\nB results');
    expect(q.outstanding).toBe(0);
  });

  it('refuses past its cap (the caller does it inline)', () => {
    const q = new DeferredQueue(1);
    expect(q.defer({ label: 'a', run: () => later(50, 'x') })).toBe('S1');
    expect(q.defer({ label: 'b', run: () => later(50, 'y') })).toBeNull();
  });

  it('a failed job reports its error; waits give up after maxMs', async () => {
    const q = new DeferredQueue(4);
    q.defer({ label: 'bad', run: async () => Promise.reject(new Error('boom')) });
    q.defer({ label: 'slow', run: () => later(5000, 'never') });
    await q.waitAny(1000);
    expect(q.take()).toBe('[Background search S1: "bad"]\nFailed: boom');
    const t0 = Date.now();
    await q.waitAll(50);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(q.take()).toBeNull();
    q.close();
  });

  it('the run ending (or its signal) stops the jobs; aborted jobs deliver nothing', async () => {
    const run = new AbortController();
    const q = new DeferredQueue(4, run.signal);
    let seen: AbortSignal | undefined;
    q.defer({
      label: 'a',
      run: (signal) => {
        seen = signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      },
    });
    await later(5, null);
    run.abort(new Error('cancel'));
    expect(seen?.aborted).toBe(true);
    await q.waitAll(1000);
    expect(q.take()).toBeNull();
    expect(q.defer({ label: 'b', run: async () => 'x' })).toBeNull();
  });
});
