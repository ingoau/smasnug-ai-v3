import { describe, expect, it } from 'vitest';
import { formatThread, omittedNote, type FormatEnv, type RenderMsg } from './format.js';
import { planHistoryWindow, type WindowOptions } from './window.js';

const ROOT = '1790000000.000000';
const ts = (i: number) => `${1790000000 + i}.000000`;
const msg = (i: number, text = `m${i}`, extra: Partial<RenderMsg> = {}): RenderMsg => ({ ts: ts(i), userId: 'U1', botId: null, username: null, text, files: [], ...extra });
/** Parent + n replies (ts 1..n). */
const thread = (n: number) => [msg(0, 'parent'), ...Array.from({ length: n }, (_, i) => msg(i + 1))];
/** Every message counts 10 chars: budgets read as "messages × 10". */
const opts = (over: Partial<WindowOptions> = {}): WindowOptions => ({ maxChars: 100, maxCount: 40, size: () => 10, compactAt: 0.8, keepFraction: 0.5, ...over });
const shownTs = (w: { replies: RenderMsg[] }) => w.replies.map((m) => m.ts);

describe('planHistoryWindow', () => {
  it('shows everything when it fits, with no summary request', () => {
    const w = planHistoryWindow(thread(5), ROOT, opts());
    expect(w.parent?.ts).toBe(ROOT);
    expect(w.replies).toHaveLength(5);
    expect(w).toMatchObject({ omitted: 0, summarised: 0, unsummarised: 0 });
    expect(w.compactTo).toBeUndefined();
  });

  it('over the budget without a summary: newest that fit (parent counted), the rest unsummarised, and a compaction target', () => {
    const w = planHistoryWindow(thread(20), ROOT, opts());
    // parent (10) + 9 replies (90) = 100
    expect(shownTs(w)).toEqual(Array.from({ length: 9 }, (_, i) => ts(12 + i)));
    expect(w).toMatchObject({ omitted: 11, summarised: 0, unsummarised: 11 });
    // keep 50% = 50 chars: parent + 4 replies (17..20) → summarise up to 16
    expect(w.compactTo).toBe(ts(16));
  });

  it('asks for compaction before the budget overflows (compactAt), while still showing everything', () => {
    // parent + 8 replies = 90 > 80 (0.8 × 100) but fits 100
    const w = planHistoryWindow(thread(8), ROOT, opts());
    expect(w.replies).toHaveLength(8);
    expect(w.omitted).toBe(0);
    expect(w.compactTo).toBe(ts(4)); // keep parent + 4 newest
  });

  it('with a summary: shows exactly the replies after it, all omitted ones summarised, no request until it grows again', () => {
    const w = planHistoryWindow(thread(10), ROOT, opts({ coveredTs: ts(4) }));
    expect(shownTs(w)).toEqual([5, 6, 7, 8, 9, 10].map(ts));
    expect(w).toMatchObject({ omitted: 4, summarised: 4, unsummarised: 0 });
    expect(w.compactTo).toBeUndefined(); // parent + 6 = 70 ≤ 80
  });

  it('the shown window only grows at its end between compactions (stable prefix)', () => {
    const a = planHistoryWindow(thread(9), ROOT, opts({ coveredTs: ts(4) }));
    const b = planHistoryWindow(thread(10), ROOT, opts({ coveredTs: ts(4) }));
    expect(shownTs(b).slice(0, a.replies.length)).toEqual(shownTs(a));
  });

  it('a burst past the budget after the summary: newest shown, the gap reported as unsummarised', () => {
    const w = planHistoryWindow(thread(30), ROOT, opts({ coveredTs: ts(4) }));
    expect(shownTs(w)).toEqual(Array.from({ length: 9 }, (_, i) => ts(22 + i)));
    expect(w).toMatchObject({ omitted: 21, summarised: 4, unsummarised: 17 });
    expect(w.compactTo).toBe(ts(26));
  });

  it('never shows a reply the summary covers, even if the summary is ahead of the window', () => {
    const w = planHistoryWindow(thread(5), ROOT, opts({ coveredTs: ts(5) }));
    expect(w.replies).toEqual([]);
    expect(w).toMatchObject({ omitted: 5, summarised: 5, unsummarised: 0 });
    expect(w.compactTo).toBeUndefined();
  });

  it('caps by count as well as size', () => {
    const w = planHistoryWindow(thread(12), ROOT, opts({ maxChars: 10_000, maxCount: 10 }));
    expect(w.replies).toHaveLength(10);
    expect(w.unsummarised).toBe(2);
    expect(w.compactTo).toBe(ts(7)); // keep 5 newest
  });

  it('drops deleted messages and works without a parent', () => {
    const msgs = [msg(1), msg(2, 'x', { deleted: true }), msg(3)];
    const w = planHistoryWindow(msgs, ROOT, opts());
    expect(w.parent).toBeUndefined();
    expect(shownTs(w)).toEqual([ts(1), ts(3)]);
  });

  it('uses real sizes: one long reply pushes the older ones out', () => {
    const msgs = [msg(0, 'parent'), msg(1), msg(2), msg(3, 'long')];
    const w = planHistoryWindow(msgs, ROOT, opts({ size: (m) => (m.text === 'long' ? 80 : 10) }));
    expect(shownTs(w)).toEqual([ts(2), ts(3)]);
    expect(w.unsummarised).toBe(1);
  });
});

describe('omitted note', () => {
  const env: FormatEnv = { names: new Map(), imageIds: new Map(), maxChars: 1000 };
  it('says how much of the omitted part the summary covers', () => {
    expect(omittedNote(3)).toBe('[3 earlier replies not shown]');
    expect(omittedNote(3, 3)).toBe('[3 earlier replies not shown; summarised in <thread_summary>]');
    expect(omittedNote(1, 0)).toBe('[1 earlier reply not shown; not summarised yet, ask_thread answers questions about them]');
    expect(omittedNote(5, 2)).toBe('[5 earlier replies not shown: the oldest 2 are summarised in <thread_summary>, the newest 3 not yet (ask_thread answers questions about them)]');
  });
  it('formatThread puts it between the parent and the shown replies', () => {
    const w = planHistoryWindow(thread(10), ROOT, opts({ coveredTs: ts(4) }));
    const lines = formatThread(w, env).split('\n');
    expect(lines[0]).toContain('parent');
    expect(lines[1]).toBe('[4 earlier replies not shown; summarised in <thread_summary>]');
    expect(lines).toHaveLength(2 + 6);
  });
});
