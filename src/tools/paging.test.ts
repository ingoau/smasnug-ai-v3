import { describe, expect, it } from 'vitest';
import type { RenderMsg } from '../context/format.js';
import { estimateRenderedChars, pageThread, takeWithinBudget, threadPageHeader } from './paging.js';

const ROOT = '1790000000.000100';
const msg = (i: number, text = `reply ${i}`): RenderMsg => ({ ts: `${1790000000 + i}.000100`, userId: 'U1', botId: null, username: null, text, files: [] });
const thread = (n: number) => [msg(0, 'parent'), ...Array.from({ length: n }, (_, i) => msg(i + 1))];
/** Every message counts 100 chars: maxChars 1000 → 10 per page. */
const size = () => 100;

describe('takeWithinBudget', () => {
  it('stops before the budget, keeps at least one, respects the count', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(takeWithinBudget(xs, 'forward', { maxChars: 250, size: () => 100 })).toEqual([1, 2]);
    expect(takeWithinBudget(xs, 'backward', { maxChars: 250, size: () => 100 })).toEqual([4, 5]);
    expect(takeWithinBudget(xs, 'backward', { maxChars: 10, size: () => 100 })).toEqual([5]);
    expect(takeWithinBudget(xs, 'forward', { maxChars: 1e9, maxCount: 3, size: () => 1 })).toEqual([1, 2, 3]);
    expect(takeWithinBudget(xs, 'forward', { maxChars: 250, reserved: 200, size: () => 100 })).toEqual([1]);
  });
});

describe('estimateRenderedChars', () => {
  it('caps the text like the renderer and adds overhead', () => {
    expect(estimateRenderedChars(msg(1, 'x'.repeat(100_000)), 8000)).toBeLessThan(8200);
    expect(estimateRenderedChars(msg(1, 'hi'), 8000)).toBeGreaterThan(2);
  });
});

describe('pageThread', () => {
  it('defaults to the newest replies, capped by size, with a cursor to older ones', () => {
    const p = pageThread(thread(120), ROOT, { maxChars: 1000, size });
    expect(p.replies.map((m) => m.text)).toEqual(Array.from({ length: 10 }, (_, i) => `reply ${111 + i}`));
    expect(p).toMatchObject({ from: 111, to: 120, total: 120, olderTs: msg(111).ts });
    expect(p.parent).toBeUndefined();
    expect(p.newerTs).toBeUndefined();
    expect(threadPageHeader(p)).toBe(`[replies 111–120 of 120 replies; older: read_thread before_ts=${msg(111).ts}; newest reply]`);
  });

  it('pages backwards with before_ts and shows the parent once it reaches the start', () => {
    const mid = pageThread(thread(120), ROOT, { before: msg(51).ts, maxChars: 1000, size });
    expect(mid).toMatchObject({ from: 41, to: 50, olderTs: msg(41).ts, newerTs: msg(50).ts });
    expect(threadPageHeader(mid)).toBe(`[replies 41–50 of 120 replies; older: read_thread before_ts=${msg(41).ts}; newer: read_thread after_ts=${msg(50).ts}]`);
    const top = pageThread(thread(120), ROOT, { before: msg(6).ts, maxChars: 1000, size });
    expect(top.parent?.text).toBe('parent');
    expect(top).toMatchObject({ from: 1, to: 5 });
    expect(top.olderTs).toBeUndefined();
    expect(threadPageHeader(top)).toMatch(/^\[parent \+ replies 1–5 of 120 replies; start of thread; newer: read_thread after_ts=/);
  });

  it('pages forwards with after_ts; the thread ts reads from the start (parent counted against the page)', () => {
    const start = pageThread(thread(120), ROOT, { after: ROOT, maxChars: 1000, size });
    expect(start.parent?.text).toBe('parent');
    expect(start).toMatchObject({ from: 1, to: 9, newerTs: msg(9).ts });
    const next = pageThread(thread(120), ROOT, { after: start.newerTs, maxChars: 1000, size });
    expect(next).toMatchObject({ from: 10, to: 19, olderTs: msg(10).ts, newerTs: msg(19).ts });
    expect(next.parent).toBeUndefined();
    const end = pageThread(thread(120), ROOT, { after: msg(115).ts, maxChars: 1000, size });
    expect(end).toMatchObject({ from: 116, to: 120 });
    expect(end.newerTs).toBeUndefined();
  });

  it('honours limit and before + after together', () => {
    expect(pageThread(thread(120), ROOT, { limit: 3, maxChars: 1e9, size })).toMatchObject({ from: 118, to: 120 });
    const range = pageThread(thread(120), ROOT, { after: msg(10).ts, before: msg(14).ts, maxChars: 1e9, size });
    expect(range.replies.map((m) => m.text)).toEqual(['reply 11', 'reply 12', 'reply 13']);
  });

  it('always includes one message, even an oversized one', () => {
    const p = pageThread([msg(0, 'parent'), msg(1, 'x'.repeat(50_000))], ROOT, { maxChars: 100, size: (m) => m.text.length });
    expect(p.replies).toHaveLength(1);
  });

  it('a thread without replies shows the parent; an empty range says so', () => {
    const only = pageThread(thread(0), ROOT, { maxChars: 1000, size });
    expect(only.parent?.text).toBe('parent');
    expect(threadPageHeader(only)).toBe('[parent only (0 replies)]');
    const none = pageThread(thread(5), ROOT, { after: msg(5).ts, maxChars: 1000, size });
    expect(none.replies).toEqual([]);
    expect(none.parent).toBeUndefined();
    expect(threadPageHeader(none)).toBe('[no replies in that range (5 replies in total)]');
  });
});
