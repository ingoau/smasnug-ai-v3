/**
 * The status indicator for a front-agent turn: the agent session's lifecycle. Best-effort everywhere: nothing here
 * ever throws into a turn.
 *
 * Researched 2026-10 on docs.slack.dev:
 *
 * - `agents.sessions.setStatus` (https://docs.slack.dev/reference/methods/agents.sessions.setStatus) sets the
 *   lifecycle: `active | processing | suspended | closed`. `processing` shows Slack's own "Working…" loading UX plus
 *   the native stop button (→ `agent_session_stopped`). It takes NO free text: "The `agents.sessions.setStatus`
 *   method does not accept a custom loading message" (https://docs.slack.dev/ai/agent-sessions/). It does NOT clear
 *   when the bot posts, so every `processing` must be followed by another status (else it times out after an hour).
 * - `assistant.threads.setStatus` (free text + `loading_messages`) is deprecated with `assistant_view` (removal
 *   February 2027, https://docs.slack.dev/changelog/2026/08/20/agent-updates/) and is no longer used. No
 *   non-deprecated method accepts a free-text status.
 * - The streaming methods take part in the session (https://docs.slack.dev/ai/agent-sessions/#messaging-interactions):
 *   `chat.startStream` sets the session `processing`, `chat.stopStream` sets `session_status` (default `active`).
 *   So a reply stream that ends mid-turn leaves the session `active`: the reply manager reports that
 *   (TurnIO.sessionReleased → `released()`), and the next tool call sets `processing` again.
 *
 * The per-tool activity text ("Searching Slack…", "Reading the page…") now lives in the turn's reply message as
 * transient `task_update` chunks (src/agent/activity-trail.ts, `STATUS_ACTIVITY_MODE=tasks`); this file only does
 * the lifecycle. DM sessions may end a turn `suspended` (waiting for a send confirmation) or `closed` (leave_thread)
 * instead of `active`: see src/pipeline/agent-session.ts.
 */
import { redis } from '../core/redis.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { markMessage } from '../core/timing.js';
import { log } from '../log.js';
import { isLocked, threadLockKey } from './lock.js';
// Cyclic, functions only (agent-session.ts imports setSessionStatus from here): resolved at call time.
import { restoreSessionStatus } from './agent-session.js';

export type SessionStatus = 'active' | 'processing' | 'suspended' | 'closed';
/** The status a turn leaves the session in (DMs only use the last two, see agent-session.ts). */
export type FinalSessionStatus = 'active' | 'suspended' | 'closed';

/** Errors meaning there is no session to manage here (wrong place, not a member …): logged at debug. */
const EXPECTED_ERRORS = new Set(['channel_not_found', 'not_in_channel', 'thread_ts_not_allowed', 'method_not_supported_for_channel_type', 'is_archived']);

/** Lifecycle status via agents.sessions.setStatus. Never throws. */
export async function setSessionStatus(channelId: string, threadTs: string, status: SessionStatus, initiatorUserId?: string): Promise<void> {
  try {
    await slackCall('agents.sessions.setStatus', {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
      ...(initiatorUserId ? { initiator_user_id: initiatorUserId } : {}),
    });
  } catch (err) {
    const code = slackErrorCode(err);
    if (code && EXPECTED_ERRORS.has(code)) log.debug({ channelId, threadTs, status, code }, 'agents.sessions.setStatus not applicable here');
    else log.warn({ err, channelId, threadTs, status }, 'agents.sessions.setStatus failed');
  }
}

export interface StatusTransport {
  lifecycle(status: SessionStatus): Promise<void>;
}

export interface TurnStatusOpts {
  channelId: string;
  threadTs: string;
  userId: string;
  /** True once the user pressed the native stop button during this turn: show nothing more. */
  stopped?: () => Promise<boolean>;
  /** Tests: replace the Slack calls. */
  transport?: StatusTransport;
}

/**
 * One turn's session status. `start()` sets `processing` right away (mention/DM turns); `setActivity()` sets it on
 * the first call (unmentioned turns commit to work) and again after `released()`. `finish()` sets the final status
 * if anything was shown — call it in a finally. All calls are serialised; none throws.
 */
export class TurnStatus {
  private readonly transport: StatusTransport;
  /** `processing` was set (or adopted) at some point this turn. */
  private shown = false;
  /** The session is `processing` as far as we know (false again after a reply stream ended). */
  private live = false;
  /** No more updates (finished, or the user pressed stop). */
  private closed = false;
  private finished = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly o: TurnStatusOpts) {
    this.transport = o.transport ?? { lifecycle: (s) => setSessionStatus(o.channelId, o.threadTs, s, o.userId) };
  }

  /** Whether the indicator is (or was) showing this turn. */
  get isShown() {
    return this.shown;
  }

  /** The session is `processing` because of this turn right now (or that is being set). */
  get isLive() {
    return this.live && !this.closed;
  }

  /** The indicator is already showing (set at intake, see showIntakeStatus): take ownership without calling Slack. */
  adopt(): void {
    if (this.shown || this.closed) return;
    this.shown = this.live = true;
  }

  /** Show the indicator now (mention/DM turns). */
  async start(): Promise<void> {
    this.commit();
    await this.chain;
  }

  /**
   * The turn started a tool that commits it to work: make sure the session is `processing`. The text is shown by
   * the reply manager (activity trail), not here. Synchronous, never blocks the caller.
   */
  setActivity(_text?: string): void {
    this.commit();
  }

  /** Slack set the session `active` by itself (a reply stream was stopped): the next activity sets `processing` again. */
  released(): void {
    this.live = false;
  }

  /** Set the final status (default `active`) if anything was shown, or if the turn asks for a non-default one. Idempotent. */
  async finish(final: FinalSessionStatus = 'active'): Promise<void> {
    if (this.finished) return this.chain;
    this.finished = true;
    this.closed = true;
    this.chain = this.chain.then(async () => {
      if (this.shown || final !== 'active') await this.safe(() => this.transport.lifecycle(final));
    });
    return this.chain;
  }

  private commit() {
    if (this.closed || this.live) return;
    this.live = true; // synchronously, so a burst of tool calls sends one `processing`
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      if (this.o.stopped && (await this.o.stopped().catch(() => false))) {
        // Native stop: the stop handler already set the session `active`; don't bring `processing` back.
        this.closed = true;
        return;
      }
      this.shown = true;
      await this.safe(() => this.transport.lifecycle('processing'));
    });
  }

  private async safe(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      log.warn({ err, channelId: this.o.channelId }, 'status update failed');
    }
  }
}

/** The running turn's indicator per thread, in this process (the turn and its tools run in the same process). */
const runningIndicators = new Map<string, TurnStatus>();

/** runTurn: register the turn's indicator while it runs. Returns the unregister function. */
export function trackTurnStatus(threadId: string, status: TurnStatus): () => void {
  runningIndicators.set(threadId, status);
  return () => {
    if (runningIndicators.get(threadId) === status) runningIndicators.delete(threadId);
  };
}

/** Mid-turn code that has to set a status itself (e.g. creating a session): is the turn's `processing` showing? */
export function turnIndicatorLive(threadId: string): boolean {
  return runningIndicators.get(threadId)?.isLive ?? false;
}

// ---- Intake status: DMs and mentions show the indicator as soon as the message is accepted ----
//
// Ownership hand-off between processes (intake runs in a slack-events job, the turn in a thread-run job):
// - intake fires the status call (fire-and-forget) and, once it returned, records `status:intake:<thread>`;
// - the turn adopts the indicator if that key is there (GETDEL), else shows it itself;
// - every turn that cleared the indicator records `status:cleared:<thread>` and drops a stale intake key;
// - if the intake call only returned after a turn already cleared the status, intake clears it again;
// - a debounce batch that ends without a turn (all messages deleted, native stop) clears it (clearIntakeStatus).
// Skipped while a turn holds the thread lock: that turn owns the indicator and the next turn shows its own.

const INTAKE_TTL_MS = 120_000;
const intakeKey = (threadId: string) => `status:intake:${threadId}`;
const clearedKey = (threadId: string) => `status:cleared:${threadId}`;

function threadParts(threadId: string) {
  const i = threadId.indexOf(':');
  return { channelId: threadId.slice(0, i), threadTs: threadId.slice(i + 1) };
}

/** Fire-and-forget: show "Working…" for a DM / mention right at intake (before the debounce window). */
export function showIntakeStatus(threadId: string, userId: string, messageTs: string): void {
  const { channelId, threadTs } = threadParts(threadId);
  const at = Date.now();
  void (async () => {
    if (await isLocked(threadLockKey(threadId))) return;
    await setSessionStatus(channelId, threadTs, 'processing', userId);
    markMessage(channelId, messageTs, { status_intake: Date.now() });
    await redis.set(intakeKey(threadId), String(at), 'PX', INTAKE_TTL_MS);
    const cleared = Number(await redis.get(clearedKey(threadId)));
    if (cleared > at) {
      // A turn finished (cleared the status) while our call was in flight: don't leave `processing` behind, and
      // put back what that turn left (DMs: maybe `suspended` / `closed`).
      await redis.del(intakeKey(threadId));
      await restoreSessionStatus(threadId, userId);
    }
  })().catch((err) => log.warn({ err, threadId }, 'intake status failed'));
}

/** Turn start: true if the intake status is showing and this turn now owns it. */
export async function adoptIntakeStatus(threadId: string): Promise<boolean> {
  const v = await redis.getdel(intakeKey(threadId)).catch(() => null);
  return v != null && Date.now() - Number(v) < INTAKE_TTL_MS;
}

/** A turn cleared the indicator: any intake status recorded before now is gone too. */
export async function noteStatusCleared(threadId: string): Promise<void> {
  await redis
    .multi()
    .set(clearedKey(threadId), String(Date.now()), 'PX', INTAKE_TTL_MS)
    .del(intakeKey(threadId))
    .exec()
    .catch(() => {});
}

/**
 * A debounce batch ended without a turn (or a turn that never showed the indicator ends): clear the intake status if
 * it is still showing, back to `status` (a turn's final status) or else the session's resting status (DMs may rest
 * `suspended` / `closed`, see agent-session.ts).
 */
export async function clearIntakeStatus(threadId: string, userId?: string, status?: FinalSessionStatus): Promise<void> {
  const v = await redis.getdel(intakeKey(threadId)).catch(() => null);
  if (v == null) return;
  const { channelId, threadTs } = threadParts(threadId);
  if (status) await setSessionStatus(channelId, threadTs, status, userId);
  else await restoreSessionStatus(threadId, userId);
}
