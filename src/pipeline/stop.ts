/**
 * Native stop button (Agents & AI Apps `agent_session_stopped`) and `@bot !stop`: stop the current response.
 * - the running front turn in the thread ends at its next step boundary (Redis flag checked via TurnIO.stopRequested),
 * - the user's not-yet-started turns (pending turns, inbox rows, open debounce batch) are dropped,
 * then the session goes back to `active` and the bot confirms with "Stopped.". The thread stays engaged and
 * background subagents keep running (the agent can cancel them or leave the thread with its tools when asked).
 * Slack has already halted the streams listed in `streaming_message_ts`; the reply manager tolerates that.
 */
import { appendEvent, threadIdOf } from '../core/events.js';
import { redis } from '../core/redis.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { clearBatch } from './debounce.js';
import { guardEntry } from './entry.js';
import { dropPendingUserTurns } from './scheduler.js';
import { restoreSessionStatus } from './agent-session.js';
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
  if (thread) {
    droppedTurns = await dropPendingUserTurns(threadId, user);
    await appendEvent(threadId, 'session_stopped', user, {
      eventTs: ev.event_ts,
      streamingMessageTs: ev.streaming_message_ts ?? [],
      droppedTurns,
    });
  }
  log.info({ threadId, user, droppedTurns }, 'agent session stopped');

  // Back to `active` — or what a DM session rests in (`suspended` while a send confirmation is pending).
  await restoreSessionStatus(threadId, user);
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
