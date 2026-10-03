/**
 * Native stop button (Agents & AI Apps `agent_session_stopped`). Behaves like the user saying "stop":
 * - the running front turn in the thread ends at its next step boundary (Redis flag checked via TurnIO.stopRequested),
 * - every active subagent run in the thread is cancelled (same path as "Stop all"),
 * - the user's not-yet-started turns (pending turns, inbox rows, open debounce batch) are dropped,
 * - the thread disengages,
 * then the session goes back to `active` and the bot confirms with "Stopped.".
 * Slack has already halted the streams listed in `streaming_message_ts`; the reply manager tolerates that.
 */
import { appendEvent, threadIdOf } from '../core/events.js';
import { redis } from '../core/redis.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { cancelThreadRuns } from '../agent/subagents.js';
import { log } from '../log.js';
import { clearBatch } from './debounce.js';
import { guardEntry } from './entry.js';
import { disengage } from './intake.js';
import { dropPendingUserTurns } from './scheduler.js';
import { setSessionStatus } from './session-status.js';
import { getThread } from './store.js';

export const STOPPED_TEXT = 'Stopped.';

/** Holds the time (ms) of the latest stop for a thread. Long enough to outlive any running turn. */
export const stopKey = (threadId: string) => `thread:${threadId}:stop`;
const STOP_TTL_S = 15 * 60;

export async function requestThreadStop(threadId: string, at = Date.now()): Promise<void> {
  await redis.set(stopKey(threadId), String(at), 'EX', STOP_TTL_S);
}

/** True if a stop was requested for the thread after `sinceMs` (i.e. while a turn started then was running). */
export async function stopRequestedSince(threadId: string, sinceMs: number): Promise<boolean> {
  const v = Number(await redis.get(stopKey(threadId)));
  return Number.isFinite(v) && v > sinceMs;
}

export interface AgentSessionStoppedEvent {
  type: 'agent_session_stopped';
  channel?: string;
  thread_ts?: string;
  user?: string;
  event_ts?: string;
  streaming_message_ts?: string[];
}

export async function handleAgentSessionStopped(ev: AgentSessionStoppedEvent): Promise<void> {
  const { channel, thread_ts: threadTs, user } = ev;
  if (!channel || !threadTs || !user) {
    log.warn({ ev }, 'agent_session_stopped without channel/thread_ts/user');
    return;
  }
  const threadId = threadIdOf(channel, threadTs);
  // Not a conversation turn: gate without counting, and without the channel. Stopping work is always allowed (it
  // only reduces activity); the guard decides whether we also post the confirmation.
  const entry = await guardEntry(user, undefined, { countMessage: false, allowSuspended: true });

  await requestThreadStop(threadId);
  await clearBatch(threadId, user);
  const thread = await getThread(threadId);
  let droppedTurns: number[] = [];
  let cancelledCards: number[] = [];
  if (thread) {
    droppedTurns = await dropPendingUserTurns(threadId, user);
    cancelledCards = await cancelThreadRuns(threadId, user).catch((err) => {
      log.error({ err, threadId }, 'cancelThreadRuns failed');
      return [];
    });
    await disengage(threadId, 'stop', user);
    await sql`update threads set last_addressed_at = now(), messages_since_addressed = 0 where id = ${threadId}`;
    await appendEvent(threadId, 'session_stopped', user, {
      eventTs: ev.event_ts,
      streamingMessageTs: ev.streaming_message_ts ?? [],
      droppedTurns,
      cancelledCards,
    });
  }
  log.info({ threadId, user, droppedTurns, cancelledCards }, 'agent session stopped');

  await setSessionStatus(channel, threadTs, 'active', user);
  if (!entry.ok) return;
  try {
    await slackCall(
      'chat.postMessage',
      { channel, thread_ts: threadTs, text: STOPPED_TEXT },
      { idempotencyKey: `session-stopped:${threadId}:${ev.event_ts ?? Date.now()}` },
    );
  } catch (err) {
    log.warn({ err, threadId }, 'failed to post stop confirmation');
  }
}
