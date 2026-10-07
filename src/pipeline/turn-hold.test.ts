import { describe, expect, it } from 'vitest';
import { decideHold, pickNextTurn, yieldCutoff, type PendingTurn } from './turn-hold.js';

const base = { nowMs: 100_000, turnHoldMaxMs: 8000, turnHoldPollMs: 1000 };

describe('decideHold', () => {
  it('runs at once when nothing is pending', () => {
    expect(decideHold({ ...base, pendingHuman: false, heldSinceMs: null })).toEqual({ hold: false, waitedMs: 0, timedOut: false });
  });

  it('holds while human input is pending, polling at most every turnHoldPollMs', () => {
    expect(decideHold({ ...base, pendingHuman: true, heldSinceMs: null })).toEqual({ hold: true, retryInMs: 1000 });
    expect(decideHold({ ...base, pendingHuman: true, heldSinceMs: base.nowMs - 3000 })).toEqual({ hold: true, retryInMs: 1000 });
  });

  it('the last poll lands on the deadline', () => {
    expect(decideHold({ ...base, pendingHuman: true, heldSinceMs: base.nowMs - 7600 })).toEqual({ hold: true, retryInMs: 400 });
  });

  it('times out after turnHoldMaxMs (fallback: the "Still being handled" note)', () => {
    expect(decideHold({ ...base, pendingHuman: true, heldSinceMs: base.nowMs - 8000 })).toEqual({ hold: false, waitedMs: 8000, timedOut: true });
    expect(decideHold({ ...base, pendingHuman: true, heldSinceMs: base.nowMs - 60_000 })).toMatchObject({ hold: false, timedOut: true });
  });

  it('reports how long a held turn waited once the input is gone', () => {
    expect(decideHold({ ...base, pendingHuman: false, heldSinceMs: base.nowMs - 2500 })).toEqual({ hold: false, waitedMs: 2500, timedOut: false });
  });

  it('a clock that went backwards never yields a negative wait', () => {
    expect(decideHold({ ...base, pendingHuman: true, heldSinceMs: base.nowMs + 500 })).toEqual({ hold: true, retryInMs: 1000 });
  });
});

const t = (id: number, kind: PendingTurn['kind'] = 'user'): PendingTurn => ({ id, kind });

describe('yieldCutoff', () => {
  it('is the newest user turn queued behind the head, else the head itself', () => {
    expect(yieldCutoff([t(5, 'synthesis'), t(7), t(9, 'scheduled'), t(8)])).toBe(8);
    expect(yieldCutoff([t(5, 'synthesis'), t(6, 'scheduled')])).toBe(5);
    expect(yieldCutoff([])).toBe(0);
  });
});

describe('pickNextTurn', () => {
  it('id order for a user head, or a non-user head without a cutoff', () => {
    expect(pickNextTurn([t(3), t(4, 'synthesis')], null)).toBe(3);
    expect(pickNextTurn([t(3, 'synthesis'), t(4)], null)).toBe(3);
    expect(pickNextTurn([], 4)).toBeNull();
  });

  it('a non-user head lets user turns up to its cutoff go first, oldest first', () => {
    expect(pickNextTurn([t(3, 'synthesis'), t(4), t(6)], 6)).toBe(4);
    expect(pickNextTurn([t(3, 'synthesis'), t(4, 'scheduled'), t(6)], 6)).toBe(6);
  });

  it('user turns queued after the cutoff wait behind it (no starvation)', () => {
    expect(pickNextTurn([t(3, 'synthesis'), t(7)], 6)).toBe(3);
    expect(pickNextTurn([t(3, 'synthesis'), t(7)], 3)).toBe(3);
  });
});
