/**
 * Turn hold and turn order for non-user turns (pure decisions; state lives in Redis, see scheduler.claimNextTurn).
 *
 * A results (synthesis) or scheduled turn that comes up while a person's newer message in the same thread is still
 * in its debounce window or at the relevance gate waits for it (bounded): otherwise that turn sees the message in
 * the thread history and tends to answer, refuse or comment on it ("I can't launch one from here"), even though the
 * message is about to get a turn of its own with its speaker's tools. Once nothing is pending (or the wait timed
 * out), the turn fixes a yield cutoff: user turns already queued behind it at that moment run first, so by the time
 * the results / reminder turn runs, those messages have been answered by their own turns. User turns created later
 * queue behind it as before (no starvation). A timed-out hold falls back to the "Still being handled" note
 * (renderQueuedTurns in src/agent/front.ts).
 */
import type { TurnRow } from '../core/types.js';

export interface HoldInput {
  /** A human message in the thread is in an open debounce batch or at the gate. */
  pendingHuman: boolean;
  /** When this turn was first held (ms), or null if it never was. */
  heldSinceMs: number | null;
  nowMs: number;
  turnHoldMaxMs: number;
  turnHoldPollMs: number;
}

export type HoldDecision = { hold: true; retryInMs: number } | { hold: false; waitedMs: number; timedOut: boolean };

/** Whether a non-user turn that is next in line should wait for pending human input. Pure. */
export function decideHold(i: HoldInput): HoldDecision {
  const waitedMs = i.heldSinceMs == null ? 0 : Math.max(0, i.nowMs - i.heldSinceMs);
  if (!i.pendingHuman) return { hold: false, waitedMs, timedOut: false };
  const left = i.turnHoldMaxMs - waitedMs;
  if (left <= 0) return { hold: false, waitedMs, timedOut: true };
  return { hold: true, retryInMs: Math.max(1, Math.min(i.turnHoldPollMs, left)) };
}

export interface PendingTurn {
  id: number;
  kind: TurnRow['kind'];
}

/**
 * The yield cutoff a non-user turn fixes once it stops waiting: the newest user turn queued behind it right now (or
 * its own id if there is none). User turns with ids up to the cutoff run before it. Pure; `pending` in id order.
 */
export function yieldCutoff(pending: PendingTurn[]): number {
  const head = pending[0];
  if (!head) return 0;
  return pending.reduce((max, p) => (p.kind === 'user' && p.id > max ? p.id : max), head.id);
}

/**
 * The turn to claim next. `pending` is in id order; `cutoff` is the head's yield cutoff when the head is a non-user
 * turn (null: it has none yet, or the head is a user turn). A non-user head lets the user turns up to its cutoff go
 * first, oldest first; otherwise turns run in id order. Pure.
 */
export function pickNextTurn(pending: PendingTurn[], cutoff: number | null): number | null {
  const head = pending[0];
  if (!head) return null;
  if (head.kind === 'user' || cutoff == null) return head.id;
  const ahead = pending.find((p) => p.kind === 'user' && p.id > head.id && p.id <= cutoff);
  return ahead ? ahead.id : head.id;
}
