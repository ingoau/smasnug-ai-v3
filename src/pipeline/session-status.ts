/**
 * The status indicator for a front-agent turn. Best-effort everywhere: nothing here ever throws into a turn.
 *
 * Two Slack APIs are involved (researched 2026-10, docs.slack.dev):
 *
 * - `agents.sessions.setStatus` (https://docs.slack.dev/reference/methods/agents.sessions.setStatus) is the
 *   current lifecycle API: `active | processing | suspended | closed`. `processing` shows Slack's own "Working…"
 *   loading UX plus the native stop button (→ `agent_session_stopped`). It takes NO free text: "The
 *   `agents.sessions.setStatus` method does not accept a custom loading message"
 *   (https://docs.slack.dev/ai/agent-sessions/). Unlike the old method it does NOT clear when the bot posts, so
 *   every `processing` must be followed by `active` (else it times out after an hour).
 * - `assistant.threads.setStatus` (https://docs.slack.dev/reference/methods/assistant.threads.setStatus) is
 *   deprecated ("replaced by agents.sessions.setStatus") but "still works through the compatibility bridge"
 *   (https://docs.slack.dev/ai/developing-agents/#loading-state). It is the only method that accepts free text:
 *   `status` (shown after the app name, e.g. "is thinking…") and `loading_messages` (rotated). It auto-clears
 *   when the app replies, '' clears it, and it times out after two minutes.
 *
 * The other documented progress surface, `task_update` / `plan_update` chunks in `chat.startStream`, needs an open
 * streaming message and leaves task cards in the transcript — a different UX (the plan card already lives in the
 * reply message), so it isn't used for the transient indicator.
 *
 * Mode `STATUS_ACTIVITY_MODE` (default `overlay`):
 * - `overlay`: `processing` via agents.sessions (keeps the native stop button) plus the activity text via the
 *   compatibility bridge on top. Third-party reports say Slack may hide the custom text while the session is in
 *   native `processing`; then this degrades to plain "Working…", nothing breaks.
 * - `text`: activity text only (reported to move the session to processing by itself, but without the stop
 *   button); `active` via agents.sessions at the end.
 * - `off`: lifecycle only (the old behaviour), with the legacy text as fallback when agents.sessions fails.
 *
 * Rate: activity updates are coalesced to at most one per `minIntervalMs` (latest text wins, unchanged text is
 * skipped); both methods are rate-limited in `src/core/slack.ts` METHOD_RPM.
 */
import { env } from '../config.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';

export type SessionStatus = 'active' | 'processing' | 'suspended' | 'closed';
export type ActivityMode = 'overlay' | 'text' | 'off';

/** Legacy status text used by the `assistant.threads.setStatus` fallback. */
export const STATUS_TEXT = 'is thinking…';
/** Activity shown at the start of a mention/DM turn, before any tool runs. */
export const INITIAL_ACTIVITY = 'Thinking…';
/** At most one activity update per this many ms. */
export const ACTIVITY_MIN_INTERVAL_MS = 1000;

/** Errors where the old method wouldn't help either (wrong place, not a member …): log at debug, no fallback. */
const EXPECTED_ERRORS = new Set(['channel_not_found', 'not_in_channel', 'thread_ts_not_allowed', 'method_not_supported_for_channel_type', 'is_archived']);

/**
 * Lifecycle status via agents.sessions.setStatus. With `fallback` (default), an unexpected failure falls back once
 * to the legacy `assistant.threads.setStatus` ('is thinking…' for processing, '' for active).
 */
export async function setSessionStatus(channelId: string, threadTs: string, status: SessionStatus, initiatorUserId?: string, opts: { fallback?: boolean } = {}): Promise<void> {
  try {
    await slackCall('agents.sessions.setStatus', {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
      ...(initiatorUserId ? { initiator_user_id: initiatorUserId } : {}),
    });
    return;
  } catch (err) {
    const code = slackErrorCode(err);
    if (code && EXPECTED_ERRORS.has(code)) {
      log.debug({ channelId, threadTs, status, code }, 'agents.sessions.setStatus not applicable here');
      return;
    }
    log.warn({ err, channelId, threadTs, status }, 'agents.sessions.setStatus failed');
  }
  // Fallback, once. The legacy method only knows a status text ('' clears it).
  if (opts.fallback === false || (status !== 'processing' && status !== 'active')) return;
  await setActivityText(channelId, threadTs, status === 'processing' ? INITIAL_ACTIVITY : '');
}

/** "Searching the web…" → status "is searching the web…" (Slack prefixes the app name). */
export function statusPhrase(text: string): string {
  if (!text) return '';
  return `is ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** Free-text activity via the legacy `assistant.threads.setStatus` (compatibility bridge). '' clears it. */
export async function setActivityText(channelId: string, threadTs: string, text: string): Promise<void> {
  try {
    await slackCall('assistant.threads.setStatus', {
      channel_id: channelId,
      thread_ts: threadTs,
      status: statusPhrase(text),
      ...(text ? { loading_messages: [text] } : {}),
    });
  } catch (err) {
    const code = slackErrorCode(err);
    if (code && EXPECTED_ERRORS.has(code)) log.debug({ channelId, code }, 'assistant.threads.setStatus not applicable here');
    else log.warn({ err, channelId, threadTs }, 'assistant.threads.setStatus failed');
  }
}

export interface StatusTransport {
  lifecycle(status: 'processing' | 'active'): Promise<void>;
  text(text: string): Promise<void>;
}

export interface TurnStatusOpts {
  channelId: string;
  threadTs: string;
  userId: string;
  /** True once the user pressed the native stop button during this turn: show nothing more. */
  stopped?: () => Promise<boolean>;
  mode?: ActivityMode;
  minIntervalMs?: number;
  /** Tests: replace the Slack calls. */
  transport?: StatusTransport;
}

/**
 * One turn's indicator. `start(text)` shows it right away (mention/DM turns); `setActivity(text)` shows it on the
 * first call (unmentioned turns commit to work) and then updates the text, coalesced. `finish()` clears it if
 * anything was shown — call it in a finally. All calls are serialised; none throws.
 */
export class TurnStatus {
  private readonly mode: ActivityMode;
  private readonly minIntervalMs: number;
  private readonly transport: StatusTransport;
  private shown = false;
  private textShown = false;
  /** No more activity updates (finished, or the user pressed stop). */
  private closed = false;
  private finished = false;
  private lastText: string | null = null;
  private lastSentAt = 0;
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly o: TurnStatusOpts) {
    this.mode = o.mode ?? env.STATUS_ACTIVITY_MODE;
    this.minIntervalMs = o.minIntervalMs ?? ACTIVITY_MIN_INTERVAL_MS;
    this.transport = o.transport ?? {
      lifecycle: (s) => setSessionStatus(o.channelId, o.threadTs, s, o.userId, { fallback: this.mode === 'off' }),
      text: (t) => setActivityText(o.channelId, o.threadTs, t),
    };
  }

  /** Whether the indicator is (or was) showing this turn. */
  get isShown() {
    return this.shown;
  }

  /** Show the indicator now (mention/DM turns). */
  async start(text = INITIAL_ACTIVITY): Promise<void> {
    this.pending = text;
    this.flushSoon(0);
    await this.chain;
  }

  /** The turn started a tool: show/update the activity text. Synchronous, never blocks the caller. */
  setActivity(text: string): void {
    if (this.closed || !text) return;
    this.pending = text;
    if (!this.shown) return this.flushSoon(0); // first commit: no delay
    if (text === this.lastText && !this.timer) {
      this.pending = null;
      return;
    }
    if (this.timer) return; // the scheduled flush picks up the latest text
    this.flushSoon(Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now()));
  }

  /** Clear the indicator if anything was shown. Idempotent. */
  async finish(): Promise<void> {
    if (this.finished) return this.chain;
    this.finished = true;
    this.closed = true;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.chain = this.chain.then(async () => {
      if (!this.shown) return;
      // Text first, lifecycle last, so `active` is the final word whatever the compatibility bridge does with ''.
      if (this.textShown) await this.safe(() => this.transport.text(''));
      await this.safe(() => this.transport.lifecycle('active'));
    });
    return this.chain;
  }

  private flushSoon(delayMs: number) {
    if (delayMs <= 0) {
      this.chain = this.chain.then(() => this.flush());
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.chain = this.chain.then(() => this.flush());
    }, delayMs);
  }

  private async flush(): Promise<void> {
    const text = this.pending;
    this.pending = null;
    if (this.closed || text == null) return;
    if (this.shown && text === this.lastText) return;
    if (this.o.stopped && (await this.o.stopped().catch(() => false))) {
      // Native stop: the stop handler already set the session `active`; don't bring `processing` back (finish()
      // still clears whatever this turn showed).
      this.closed = true;
      return;
    }
    if (!this.shown) {
      this.shown = true;
      if (this.mode !== 'text') await this.safe(() => this.transport.lifecycle('processing'));
    }
    if (this.mode !== 'off') {
      this.textShown = true;
      await this.safe(() => this.transport.text(text));
    }
    this.lastText = text;
    this.lastSentAt = Date.now();
  }

  private async safe(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      log.warn({ err, channelId: this.o.channelId }, 'status update failed');
    }
  }
}
