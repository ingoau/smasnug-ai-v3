/**
 * The shared Slack rate limiter (acquireRateSlot) against the test Redis: FIFO order, the interactive reserve,
 * fail-fast deadlines and stale tickets. Short windows (windowMs) stand in for Slack's 60 s.
 */
import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from './redis.js';
import { acquireRateSlot, SlackBusyError } from './slack.js';

let n = 0;
const newKey = () => `slack:rl:test:${process.pid}:${Date.now()}:${n++}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  await sql.end();
});

describe('acquireRateSlot', () => {
  it('grants up to perMin at once, then the next caller waits for the oldest slot to expire', async () => {
    const key = newKey();
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) expect(await acquireRateSlot(key, { perMin: 3, windowMs: 600 })).toBeLessThan(100);
    let estimate = 0;
    const waited = await acquireRateSlot(key, { perMin: 3, windowMs: 600, onWait: (ms) => (estimate = ms) });
    expect(estimate).toBeGreaterThan(300);
    expect(estimate).toBeLessThanOrEqual(600);
    expect(waited).toBeGreaterThan(300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(590);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('fails fast with SlackBusyError when the expected wait passes the deadline, and leaves the queue', async () => {
    const key = newKey();
    await acquireRateSlot(key, { perMin: 1, windowMs: 5000 });
    const t0 = Date.now();
    const err = await acquireRateSlot(key, { perMin: 1, windowMs: 5000, deadline: Date.now() + 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackBusyError);
    expect(err.waitMs).toBeGreaterThan(3000);
    // Doesn't sit out the deadline: it knows up front that no slot frees in time.
    expect(Date.now() - t0).toBeLessThan(300);
    expect(await redis.zcard(`${key}:qi`)).toBe(0);
    expect(await redis.zcard(`${key}:qb`)).toBe(0);
  });

  it('serves waiting callers in arrival order (FIFO)', async () => {
    const key = newKey();
    const order: number[] = [];
    // Fill the window (one slot at a time, so grants are strictly sequential), then queue 6 callers in a known order.
    await acquireRateSlot(key, { perMin: 1, windowMs: 200 });
    const waiters: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) {
      waiters.push(acquireRateSlot(key, { perMin: 1, windowMs: 200 }).then(() => void order.push(i)));
      await sleep(15); // each one has taken its ticket before the next arrives
    }
    await Promise.all(waiters);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a fail-fast caller that would wait too long does not hold up the callers behind it', async () => {
    const key = newKey();
    await acquireRateSlot(key, { perMin: 1, windowMs: 400 });
    const first = acquireRateSlot(key, { perMin: 1, windowMs: 400 });
    await sleep(10);
    await expect(acquireRateSlot(key, { perMin: 1, windowMs: 400, deadline: Date.now() + 50 })).rejects.toBeInstanceOf(SlackBusyError);
    const third = acquireRateSlot(key, { perMin: 1, windowMs: 400 });
    const t0 = Date.now();
    await first;
    await third;
    // first at ~400 ms, third one window later: the busy caller's ticket is gone.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('background callers stop at perMin - reserve; interactive callers can use the reserve', async () => {
    const key = newKey();
    const opts = { perMin: 4, reserve: 2, windowMs: 3000 };
    await acquireRateSlot(key, { ...opts, priority: 'background' });
    await acquireRateSlot(key, { ...opts, priority: 'background' });
    // Third background call: the remaining 2 slots are the interactive reserve.
    await expect(acquireRateSlot(key, { ...opts, priority: 'background', deadline: Date.now() + 200 })).rejects.toBeInstanceOf(SlackBusyError);
    const t0 = Date.now();
    await acquireRateSlot(key, { ...opts, priority: 'interactive' });
    await acquireRateSlot(key, { ...opts, priority: 'interactive' });
    expect(Date.now() - t0).toBeLessThan(200);
    await expect(acquireRateSlot(key, { ...opts, priority: 'interactive', deadline: Date.now() + 200 })).rejects.toBeInstanceOf(SlackBusyError);
  });

  it('a queued interactive caller is served before background callers that queued earlier', async () => {
    const key = newKey();
    const opts = { perMin: 2, windowMs: 400 };
    // Slots granted 150 ms apart, so they free one at a time.
    await acquireRateSlot(key, opts);
    await sleep(150);
    await acquireRateSlot(key, opts);
    const order: string[] = [];
    const b1 = acquireRateSlot(key, { ...opts, priority: 'background' }).then(() => void order.push('b1'));
    await sleep(15);
    const b2 = acquireRateSlot(key, { ...opts, priority: 'background' }).then(() => void order.push('b2'));
    await sleep(15);
    const i1 = acquireRateSlot(key, { ...opts, priority: 'interactive' }).then(() => void order.push('i1'));
    await Promise.all([b1, b2, i1]);
    expect(order[0]).toBe('i1');
    expect(order.slice(1)).toEqual(['b1', 'b2']);
  });

  it("drops a dead process's stale ticket instead of queueing behind it forever", async () => {
    const key = newKey();
    await acquireRateSlot(key, { perMin: 1, windowMs: 300 });
    // A ticket whose owner died 30 s ago (heartbeat never refreshed), ahead of everyone.
    await redis.zadd(`${key}:qi`, 0, 'dead-ticket');
    await redis.zadd(`${key}:seen`, Date.now() - 30_000, 'dead-ticket');
    const t0 = Date.now();
    await acquireRateSlot(key, { perMin: 1, windowMs: 300 });
    expect(Date.now() - t0).toBeLessThan(800);
    expect(await redis.zscore(`${key}:qi`, 'dead-ticket')).toBeNull();
  });

  it('many concurrent callers with a deadline: each is either served within it or told busy right away', async () => {
    const key = newKey();
    const opts = { perMin: 5, windowMs: 2000 };
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const t0 = Date.now();
        try {
          await acquireRateSlot(key, { ...opts, deadline: Date.now() + 300 });
          return { ok: true, ms: Date.now() - t0 };
        } catch (err) {
          expect(err).toBeInstanceOf(SlackBusyError);
          return { ok: false, ms: Date.now() - t0 };
        }
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    for (const r of results) expect(r.ms).toBeLessThan(400);
  });
});
