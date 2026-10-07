import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { isOrphan, RECONCILE_GRACE_MS, type SandboxState } from './lifecycle.js';

const now = Date.parse('2026-10-07T06:00:00Z');
const old = new Date(now - RECONCILE_GRACE_MS - 1000);
const fresh = new Date(now - 5_000);
const row = (state: SandboxState, providerId: string | null, updatedAt = old) => ({ state, providerId, updatedAt });
const box = { providerId: 'p1' };

describe('isOrphan (sandbox reconcile)', () => {
  it('a box without a row is an orphan', () => expect(isOrphan(box, null, now)).toBe(true));

  it('every non-terminal row keeps its own box (a pause in progress is not an orphan)', () => {
    for (const s of ['creating', 'running', 'pausing', 'resuming', 'destroying'] as const) expect(isOrphan(box, row(s, 'p1'), now)).toBe(false);
  });

  it('a creating / resuming row keeps a tagged box whose id it has not stored yet', () => {
    expect(isOrphan(box, row('creating', null), now)).toBe(false);
    expect(isOrphan(box, row('resuming', 'p0'), now)).toBe(false);
  });

  it('an old box of a row that moved on is an orphan', () => {
    expect(isOrphan(box, row('running', 'p2'), now)).toBe(true);
    expect(isOrphan(box, row('pausing', 'p2'), now)).toBe(true);
  });

  it('ended rows: orphan after the grace period, kept within it', () => {
    for (const s of ['paused', 'lost', 'destroyed'] as const) {
      expect(isOrphan(box, row(s, null), now)).toBe(true);
      expect(isOrphan(box, row(s, null, fresh), now)).toBe(false);
    }
  });
});
