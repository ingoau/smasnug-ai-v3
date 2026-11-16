/**
 * `@bot !stop` (anyone; guidelines rule 2): stop the current response. The native stop button (Agents & AI Apps
 * `agent_session_stopped`) is gone: the app no longer subscribes to the event (people clicked it by accident), but the
 * handler keeps its event shape and still works if the event arrives.
 * - the running front turn in the thread is aborted mid-step (Redis flag polled via TurnIO.stopRequested; the model
 *   call and its tools get an AbortSignal, and no tool starts once it fired),
 * - the user's not-yet-started turns (pending turns, inbox rows, open debounce batch) are dropped,
 * then the session goes back to `active` and the bot confirms with "Stopped.". The thread stays engaged and
 * background subagents keep running (the agent can cancel them or leave the thread with its tools when asked).
 * Slack has already halted the streams listed in `streaming_message_ts`; the reply manager tolerates that.
 */
import { appendEvent, codeChannelThreadId, isCodeChannelRoot, threadIdOf, threadTsArg } from '../core/events.js';
import { redis } from '../core/redis.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { clearBatch } from './debounce.js';
import { guardEntry } from './entry.js';
import { dropPendingUserTurns } from './scheduler.js';
import { restoreSessionStatus } from './agent-session.js';
import { getThread } from './store.js';
import { codeChannelsEnabled } from '../features/code-channels/settings.js';
import { isCodeChannel } from '../features/code-channels/store.js';

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
  /** `message_stream_stopped` is the event's old name; Slack sends both while the rename rolls out. */
  type: 'agent_session_stopped' | 'message_stream_stopped';
  channel?: string;
  thread_ts?: string;
  user?: string;
  event_ts?: string;
  streaming_message_ts?: string[];
}

/**
 * The thread an `agent_session_stopped` is for. In a code channel (docs/code-channels.md) the session is the
 * channel: no thread_ts means its conversation `${channel}:0`, a thread_ts that thread. Elsewhere thread_ts is required.
 */
export async function stoppedThreadId(channel: string, threadTs: string | undefined): Promise<string | null> {
  if (threadTs) return threadIdOf(channel, threadTs);
  if (channel.startsWith('D') || !(await codeChannelsEnabled())) return null;
  return (await isCodeChannel(channel).catch(() => false)) ? codeChannelThreadId(channel) : null;
}

/** Both names of one stop arrive within moments of each other: only the first within this window counts. */
const NATIVE_STOP_DEDUPE_MS = 15_000;

/**
 * The dedupe key of a native stop (pure): the same click under either event name maps to the same key (channel,
 * thread, user, and the streams it halted when Slack lists them).
 */
export function nativeStopDedupeKey(ev: Pick<AgentSessionStoppedEvent, 'channel' | 'thread_ts' | 'user' | 'streaming_message_ts'>): string {
  const streams = [...(ev.streaming_message_ts ?? [])].sort().join(',');
  return `stop:native:${ev.channel ?? ''}:${ev.thread_ts ?? '0'}:${ev.user ?? ''}:${streams}`;
}

/**
 * A native stop event from Slack (`agent_session_stopped` or its old name `message_stream_stopped`, which Slack
 * fires as well during the rename): handled once. Fail open (a Redis error handles it).
 */
export async function handleNativeStopEvent(ev: AgentSessionStoppedEvent): Promise<void> {
  const first = await redis
    .set(nativeStopDedupeKey(ev), ev.type, 'PX', NATIVE_STOP_DEDUPE_MS, 'NX')
    .then((r) => r === 'OK')
    .catch(() => true);
  if (!first) {
    log.debug({ type: ev.type, channel: ev.channel }, 'duplicate native stop event ignored');
    return;
  }
  return handleAgentSessionStopped(ev, { native: true });
}

/**
 * `native`: the event came from Slack (not `!stop`). In a code channel Slack wants no further `agents.*` calls for
 * that context after a stop, so the session status is left to Slack.
 */
export async function handleAgentSessionStopped(ev: AgentSessionStoppedEvent, opts: { native?: boolean } = {}): Promise<void> {
  const { channel, thread_ts: eventThreadTs, user } = ev;
  const threadId = channel && user ? await stoppedThreadId(channel, eventThreadTs) : null;
  if (!channel || !user || !threadId) {
    log.warn({ ev }, 'agent_session_stopped without channel/thread_ts/user');
    return;
  }
  const threadTs = threadId.slice(channel.length + 1);
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
  if (!(opts.native && isCodeChannelRoot(threadTs))) await restoreSessionStatus(threadId, user);
  if (!entry.ok) return;
  try {
    await slackCall(
      'chat.postMessage',
      { channel, ...threadTsArg(threadTs), text: STOPPED_TEXT },
      { idempotencyKey: `session-stopped:${threadId}:${ev.event_ts ?? Date.now()}` },
    );
  } catch (err) {
    log.warn({ err, threadId }, 'failed to post stop confirmation');
  }
}
