/**
 * thread-run processor: one front agent per thread at a time. The holder of the Redis thread lock drains pending
 * turns in id order; anyone else returns immediately (the holder picks their turn up). After releasing, the holder
 * re-checks for pending turns and re-enqueues, so no wakeup is lost.
 */
import type { Job } from 'bullmq';
import { runFrontTurn, type TurnIO } from '../agent/front.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { slackCall, ThreadGoneError } from '../core/slack.js';
import type { TurnRow } from '../core/types.js';
import { log } from '../log.js';
import { loadMessageMarks, timingReport, TurnTiming } from '../core/timing.js';
import { acquireLock, threadLockKey, THREAD_LOCK_TTL_MS, type HeldLock } from './lock.js';
import { claimNextPending, drainInbox, ensureThreadRun, finishTurn, hasPendingTurns, runningTurnIds, setPhase } from './scheduler.js';
import { adoptIntakeStatus, clearIntakeStatus, noteStatusCleared, setSessionStatus, trackTurnStatus, TurnStatus, type FinalSessionStatus } from './session-status.js';
import { removeOpenActivity } from '../agent/activity-registry.js';
import { finalSessionStatus, isNotedSuspended, noteSessionSettled, noteSessionSuspended, resumeSuspendedSession } from './agent-session.js';
import { stopRequestedSince } from './stop.js';
import { currentlyViewing } from './view-context.js';

export const ERROR_TEXT = 'Something broke, try again.';

/** In-process bookkeeping for graceful shutdown only (correctness never depends on it). */
const inFlight = new Map<number, { threadId: string; lock: HeldLock; turn: TurnRow; status?: TurnStatus }>();
let shuttingDown = false;

export async function processThreadRun(job: Job<{ threadId: string }>) {
  const { threadId } = job.data;
  const pickedAt = Date.now();
  if (shuttingDown) {
    await ensureThreadRun(threadId); // leave it for another worker
    return;
  }
  const lock = await acquireLock(threadLockKey(threadId), THREAD_LOCK_TTL_MS);
  if (!lock) return;
  const lockedAt = Date.now();
  let first = true;
  let lastFinal: FinalSessionStatus | null = null;
  try {
    // We hold the lock, so nothing else is running here: any 'running' turn is left over from a crash.
    for (const id of await runningTurnIds(threadId)) {
      log.warn({ threadId, turnId: id }, 'marking stale running turn as error');
      await settleAbandonedTurn(threadId, Number(id));
      await finishTurn(id, 'error');
      await appendEvent(threadId, 'turn_finished', 'system', { turnId: id, status: 'error', reason: 'stale' });
    }
    while (!shuttingDown && lock.held) {
      const turn = await claimNextPending(threadId);
      if (!turn) break;
      const timing = new TurnTiming();
      if (first) {
        timing.mark('run_picked', pickedAt);
        timing.mark('lock_acquired', lockedAt);
        first = false;
      }
      timing.mark('turn_claimed');
      const entry: { threadId: string; lock: HeldLock; turn: TurnRow; status?: TurnStatus } = { threadId, lock, turn };
      inFlight.set(turn.id, entry);
      try {
        lastFinal = await runTurn(turn, (status) => (entry.status = status), timing);
      } finally {
        inFlight.delete(turn.id);
      }
    }
  } finally {
    await lock.release();
  }
  // A Send / Cancel click between the last turn's final status and the release skipped resuming (lock held): the
  // session may still say `suspended` with nothing pending. Re-check now. Same when a confirmation was resolved while
  // turns ran here (e.g. an expiry whose silent outcome turn never touched the status): its note is still there.
  if (lastFinal === 'suspended' || (lastFinal && (await isNotedSuspended(threadId)))) await resumeSuspendedSession(threadId);
  if (await hasPendingTurns(threadId)) await ensureThreadRun(threadId);
}

/** Runs one turn under the thread lock; returns the status it left the session in. */
export async function runTurn(turn: TurnRow, onStatus?: (status: TurnStatus) => void, timing = new TurnTiming()): Promise<FinalSessionStatus> {
  const { channelId, threadTs } = parseThreadId(turn.threadId);
  const started = Date.now();
  const stopRequested = () => stopRequestedSince(turn.threadId, started);
  await appendEvent(turn.threadId, 'turn_started', turn.authorId, { turnId: turn.id, kind: turn.kind, messageTs: turn.messageTs, isMention: turn.isMention });
  // Status is turn-scoped (design doc): mention/DM turns show it from the start; other turns only once the agent
  // commits to work (its first lookup — io.setActivity); a direct reply or silence never shows one. Cleared in the
  // finally below.
  const indicator = new TurnStatus({ channelId, threadTs, userId: turn.authorId, stopped: stopRequested });
  onStatus?.(indicator);
  const untrack = trackTurnStatus(turn.threadId, indicator);
  // DMs / mentions usually already show the status from intake (adopted here); otherwise show it now. Never awaited:
  // the model call must not wait for Slack.
  if (turn.isMention) {
    if (await adoptIntakeStatus(turn.threadId)) indicator.adopt();
    else void indicator.start().then(() => timing.mark('status_done'));
  }
  const io: TurnIO = {
    timing,
    drainInbox: () => drainInbox(turn.id, turn.threadId),
    setPhase: (phase) => setPhase(turn.id, phase),
    isMention: turn.isMention,
    setActivity: (text) => indicator.setActivity(text),
    sessionReleased: () => indicator.released(),
    stopRequested,
    // DM / agent-container turns: what the user is looking at next to the container.
    viewingChannelId: turn.kind === 'user' && channelId.startsWith('D') ? await currentlyViewing(turn.authorId, channelId) : null,
  };
  let status: 'done' | 'error' | 'cancelled' = 'done';
  let error: string | undefined;
  let final: FinalSessionStatus = 'active';
  try {
    await runFrontTurn(turn, io);
  } catch (err) {
    status = 'error';
    error = (err as Error)?.message ?? String(err);
    if (err instanceof ThreadGoneError) {
      // The thread's root was deleted mid-turn: nothing to post, nowhere to post it.
      status = 'cancelled';
      log.info({ turnId: turn.id, threadId: turn.threadId }, 'thread root deleted during the turn; turn cancelled');
    } else {
      log.error({ err, turnId: turn.id, threadId: turn.threadId }, 'front turn failed');
      try {
        await slackCall('chat.postMessage', { channel: channelId, thread_ts: threadTs, text: ERROR_TEXT }, { idempotencyKey: `turn-error:${turn.id}` });
      } catch (postErr) {
        log.error({ err: postErr, turnId: turn.id }, 'failed to post error message');
      }
    }
  } finally {
    // DMs may end `suspended` (a send confirmation is pending) or `closed` (leave_thread); else `active`.
    final = await finalSessionStatus(turn.threadId, Number(turn.id)).catch((err) => (log.warn({ err }, 'finalSessionStatus failed'), 'active' as const));
    await indicator.finish(final);
    untrack();
    // Resume promptly when the confirmation expires (not only at the next expiry sweep).
    if (final === 'suspended') await noteSessionSuspended(turn.threadId);
    else if (indicator.isShown) await noteSessionSettled(turn.threadId);
    // This turn cleared the indicator (any intake status with it); a turn that never showed one still takes back an
    // intake status left for messages that ended up in its inbox.
    if (indicator.isShown) await noteStatusCleared(turn.threadId);
    else await clearIntakeStatus(turn.threadId, turn.authorId, final);
    const followUp = await finishTurn(turn.id, status);
    await appendEvent(turn.threadId, 'turn_finished', 'system', {
      turnId: turn.id,
      status,
      durationMs: Date.now() - started,
      ...(error ? { error: error.slice(0, 500) } : {}),
      ...(followUp ? { leftoverInboxTurnId: followUp } : {}),
    });
    timing.mark('turn_end');
    await reportTiming(turn, timing).catch((err) => log.debug({ err }, 'turn timing report failed'));
  }
  return final;
}

/** One `turn_timing` event + log line per turn: pipeline marks of its first message plus the turn's own marks. */
async function reportTiming(turn: TurnRow, timing: TurnTiming) {
  const { channelId } = parseThreadId(turn.threadId);
  const firstTs = [...(turn.messageTs ?? [])].sort((a, b) => Number(a) - Number(b))[0];
  const msgMarks = firstTs ? await loadMessageMarks(channelId, firstTs) : {};
  const report = timingReport(msgMarks, timing);
  await appendEvent(turn.threadId, 'turn_timing', 'system', { turnId: turn.id, kind: turn.kind, messageTs: firstTs ?? null, ...report });
  log.info({ turnId: turn.id, threadId: turn.threadId, ...report.headline, rel: report.rel, spans: report.spans, counters: report.counters, notes: report.notes }, 'turn_timing');
}

/**
 * A turn that won't end normally (worker crash → stale-turn sweep, or shutdown): remove the activity message it left
 * open and set the session's final status (DMs may stay `suspended` / `closed`), so no task card keeps spinning and
 * the session isn't left `processing` for an hour. A later turn shows its own indicator. Never throws.
 */
async function settleAbandonedTurn(threadId: string, turnId: number, status?: TurnStatus) {
  try {
    await removeOpenActivity(turnId);
    const final = await finalSessionStatus(threadId, turnId).catch(() => 'active' as const);
    if (status) await status.finish(final);
    else {
      const { channelId, threadTs } = parseThreadId(threadId);
      await setSessionStatus(channelId, threadTs, final);
    }
    await noteStatusCleared(threadId);
  } catch (err) {
    log.warn({ err, threadId, turnId }, 'settling an abandoned turn failed');
  }
}

/**
 * Shutdown: stop claiming turns, give in-flight turns `graceMs` to finish, then mark the rest errored, release their
 * locks and hand the threads to other workers.
 */
export async function shutdownThreadRuns(graceMs: number) {
  shuttingDown = true;
  const deadline = Date.now() + graceMs;
  while (inFlight.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  for (const [turnId, { threadId, lock, status }] of inFlight) {
    log.warn({ turnId, threadId }, 'shutdown: abandoning in-flight turn');
    // Otherwise the session would stay `processing` for up to an hour.
    await settleAbandonedTurn(threadId, turnId, status);
    await finishTurn(turnId, 'error').catch(() => {});
    await appendEvent(threadId, 'turn_finished', 'system', { turnId, status: 'error', reason: 'shutdown' }).catch(() => {});
    await lock.release().catch(() => {});
    await ensureThreadRun(threadId).catch(() => {});
  }
  inFlight.clear();
}

/** Test hook. */
export function _resetShutdownState() {
  shuttingDown = false;
}
