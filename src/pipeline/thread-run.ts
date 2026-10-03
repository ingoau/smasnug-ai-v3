/**
 * thread-run processor: one front agent per thread at a time. The holder of the Redis thread lock drains pending
 * turns in id order; anyone else returns immediately (the holder picks their turn up). After releasing, the holder
 * re-checks for pending turns and re-enqueues, so no wakeup is lost.
 */
import type { Job } from 'bullmq';
import { runFrontTurn, type TurnIO } from '../agent/front.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import type { TurnRow } from '../core/types.js';
import { log } from '../log.js';
import { acquireLock, threadLockKey, THREAD_LOCK_TTL_MS, type HeldLock } from './lock.js';
import { claimNextPending, drainInbox, ensureThreadRun, finishTurn, hasPendingTurns, runningTurnIds, setPhase } from './scheduler.js';
import { TurnStatus } from './session-status.js';
import { stopRequestedSince } from './stop.js';
import { currentlyViewing } from './view-context.js';

export { STATUS_TEXT } from './session-status.js';
export const ERROR_TEXT = 'Something broke, try again.';

/** In-process bookkeeping for graceful shutdown only (correctness never depends on it). */
const inFlight = new Map<number, { threadId: string; lock: HeldLock; turn: TurnRow; status?: TurnStatus }>();
let shuttingDown = false;

export async function processThreadRun(job: Job<{ threadId: string }>) {
  const { threadId } = job.data;
  if (shuttingDown) {
    await ensureThreadRun(threadId); // leave it for another worker
    return;
  }
  const lock = await acquireLock(threadLockKey(threadId), THREAD_LOCK_TTL_MS);
  if (!lock) return;
  try {
    // We hold the lock, so nothing else is running here: any 'running' turn is left over from a crash.
    for (const id of await runningTurnIds(threadId)) {
      log.warn({ threadId, turnId: id }, 'marking stale running turn as error');
      await finishTurn(id, 'error');
      await appendEvent(threadId, 'turn_finished', 'system', { turnId: id, status: 'error', reason: 'stale' });
    }
    while (!shuttingDown && lock.held) {
      const turn = await claimNextPending(threadId);
      if (!turn) break;
      const entry: { threadId: string; lock: HeldLock; turn: TurnRow; status?: TurnStatus } = { threadId, lock, turn };
      inFlight.set(turn.id, entry);
      try {
        await runTurn(turn, (status) => (entry.status = status));
      } finally {
        inFlight.delete(turn.id);
      }
    }
  } finally {
    await lock.release();
  }
  if (await hasPendingTurns(threadId)) await ensureThreadRun(threadId);
}

export async function runTurn(turn: TurnRow, onStatus?: (status: TurnStatus) => void) {
  const { channelId, threadTs } = parseThreadId(turn.threadId);
  const started = Date.now();
  const stopRequested = () => stopRequestedSince(turn.threadId, started);
  await appendEvent(turn.threadId, 'turn_started', turn.authorId, { turnId: turn.id, kind: turn.kind, messageTs: turn.messageTs, isMention: turn.isMention });
  // Status is turn-scoped (design doc): mention/DM turns show it from the start; other turns only once the agent
  // commits to work (its first lookup — io.setActivity); a direct reply or silence never shows one. Cleared in the
  // finally below.
  const indicator = new TurnStatus({ channelId, threadTs, userId: turn.authorId, stopped: stopRequested });
  onStatus?.(indicator);
  if (turn.isMention) await indicator.start();
  const io: TurnIO = {
    drainInbox: () => drainInbox(turn.id, turn.threadId),
    setPhase: (phase) => setPhase(turn.id, phase),
    isMention: turn.isMention,
    setActivity: (text) => indicator.setActivity(text),
    stopRequested,
    // DM / agent-container turns: what the user is looking at next to the container.
    viewingChannelId: turn.kind === 'user' && channelId.startsWith('D') ? await currentlyViewing(turn.authorId, channelId) : null,
  };
  let status: 'done' | 'error' = 'done';
  let error: string | undefined;
  try {
    await runFrontTurn(turn, io);
  } catch (err) {
    status = 'error';
    error = (err as Error)?.message ?? String(err);
    log.error({ err, turnId: turn.id, threadId: turn.threadId }, 'front turn failed');
    try {
      await slackCall('chat.postMessage', { channel: channelId, thread_ts: threadTs, text: ERROR_TEXT }, { idempotencyKey: `turn-error:${turn.id}` });
    } catch (postErr) {
      log.error({ err: postErr, turnId: turn.id }, 'failed to post error message');
    }
  } finally {
    await indicator.finish();
    const followUp = await finishTurn(turn.id, status);
    await appendEvent(turn.threadId, 'turn_finished', 'system', {
      turnId: turn.id,
      status,
      durationMs: Date.now() - started,
      ...(error ? { error: error.slice(0, 500) } : {}),
      ...(followUp ? { leftoverInboxTurnId: followUp } : {}),
    });
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
    // Otherwise the session would stay `processing` (with a stop button) for up to an hour.
    await status?.finish();
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
