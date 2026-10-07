/**
 * Activity trail: the per-tool activity text ("Searching Slack…", "Reading the page…") as transient task cards in
 * the turn's reply message (`STATUS_ACTIVITY_MODE=tasks`).
 *
 * Why here: the only free-text status method, `assistant.threads.setStatus`, is deprecated (removal February 2027,
 * https://docs.slack.dev/changelog/2026/08/20/agent-updates/), and its replacement `agents.sessions.setStatus`
 * "does not accept a custom loading message" (https://docs.slack.dev/ai/agent-sessions/). The non-deprecated
 * progress surface is the streaming API: `task_update` chunks (`{ type, id, title, status }`, ≤ 256 chars,
 * https://docs.slack.dev/reference/methods/chat.startStream#task_update-chunks) render as task cards in the default
 * `timeline` display mode, interleaved with streamed text.
 *
 * How it stays transient (the UX of the old status line):
 * - The first activity of a turn opens a stream that holds only a task card (in progress); later activities mark
 *   the previous card complete and add a new one, coalesced to at most one update per second (latest text wins,
 *   unchanged text is skipped). Nothing is shown before the turn commits to work (same rule as the status).
 * - When the turn's next reply starts streaming, it adopts this message (ReplyManager): the reply text streams in
 *   below the cards, and the finished reply is re-rendered with chat.update without them, so the final message is
 *   exactly the posted reply. A reply that is posted whole (subagents running) deletes the activity message. So does
 *   a reply when anything was posted in the thread after the activity message (a user message, send_message, …):
 *   adopting it would put the reply above that post; the reply opens a message of its own instead.
 * - At the end of the turn, an activity message no reply adopted (silent turn, error, stop) is deleted, so it
 *   leaves nothing behind.
 * Best-effort: any failure only drops the activity text for the rest of the turn; nothing here throws.
 */
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';

/** At most one activity update per this many ms. */
export const ACTIVITY_MIN_INTERVAL_MS = 1000;
/** Cards per activity message; later activities are dropped (a turn has at most a dozen steps anyway). */
const MAX_CARDS = 10;
/** Slack's limit for task_update chunks. */
const MAX_TITLE = 250;

export interface TaskUpdateChunk {
  type: 'task_update';
  id: string;
  title: string;
  status: 'in_progress' | 'complete';
}

export interface ActivityTarget {
  channelId: string;
  threadTs: string;
  turnId: number;
  /** Recipient for streams outside DMs (chat.startStream requires it in channels). */
  recipientUserId: string;
  teamId: () => Promise<string | undefined>;
  /** True once the turn was stopped (`!stop`): open nothing more. */
  stopRequested?: () => Promise<boolean>;
  /** chat.stopStream set the session `active` (its default `session_status`). */
  onSessionReleased?: () => void;
  /** Crash safety (activity-registry.ts): a message was opened / is no longer the trail's. Errors are ignored. */
  onOpened?: (ts: string) => Promise<void>;
  onClosed?: () => Promise<void>;
  minIntervalMs?: number;
}

/** What a reply takes over: the open message, plus the chunks that complete its in-progress card. */
export interface AdoptedActivity {
  ts: string;
  chunks: TaskUpdateChunk[];
  cards: number;
  /** Idempotency key for stopping it, should the reply not be able to use it after all (dropAdopted). */
  stopKey: string;
}

const card = (id: string, title: string, status: TaskUpdateChunk['status']): TaskUpdateChunk => ({ type: 'task_update', id, title, status });

export class ActivityTrail {
  /** The open activity message (no reply has adopted it yet). */
  private ts: string | null = null;
  /** Cards in the open message; the last one is in progress. */
  private cards: { id: string; title: string }[] = [];
  /** Activity messages opened this turn (idempotency keys). */
  private opened = 0;
  /** A message is open or being opened. */
  private started = false;
  /** appendStream failed on the open message (e.g. Slack halted it): no more updates, delete it at the end. */
  private broken = false;
  /** Something was posted in the thread below the open message: a reply must not stream into it (above that post). */
  private passed = false;
  /** No more activity this turn (closed, stopped, or Slack refused the stream). */
  private disabled = false;
  private pending: string | null = null;
  private lastSentAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly minIntervalMs: number;

  constructor(private readonly t: ActivityTarget) {
    this.minIntervalMs = t.minIntervalMs ?? ACTIVITY_MIN_INTERVAL_MS;
  }

  /** True while an activity message is open (or being opened) that a reply could adopt. */
  get isOpen() {
    return this.started && !this.broken;
  }

  /** A tool that commits the turn to work started: show / update its card. Synchronous, never blocks. */
  activity(text: string): void {
    if (this.disabled || this.broken || !text) return;
    this.pending = text.slice(0, MAX_TITLE);
    if (!this.started) {
      this.started = true;
      return this.flushSoon(0); // first activity: no delay
    }
    if (this.pending === this.cards.at(-1)?.title && !this.timer) {
      this.pending = null;
      return;
    }
    if (this.timer) return; // the scheduled flush picks up the latest text
    this.flushSoon(Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now()));
  }

  /**
   * A reply is about to open its stream: hand over the open activity message (null if there is none). The trail
   * starts afresh, so activity after this reply opens a new message.
   */
  adopt(): Promise<AdoptedActivity | null> {
    this.cancelPending();
    return this.enqueue(async () => {
      if (!this.ts) {
        this.reset(); // nothing went out yet (the pending card was dropped above)
        return null;
      }
      if (this.broken) return null; // close() deletes it
      if (this.passed) {
        // A reply streamed into it would land above what was posted meanwhile: remove it, the reply opens its own.
        await this.remove();
        return null;
      }
      const last = this.cards.at(-1);
      const adopted: AdoptedActivity = { ts: this.ts, chunks: last ? [card(last.id, last.title, 'complete')] : [], cards: this.cards.length, stopKey: this.key(':stop') };
      this.reset();
      await this.hook(() => this.t.onClosed?.()); // the reply owns it now
      return adopted;
    });
  }

  /**
   * A reply adopted the message but can't use it (Slack already ended its stream, or the thread moved on below it):
   * stop and delete it, so the reply opens a fresh message instead. Never throws.
   */
  dropAdopted(a: AdoptedActivity): Promise<void> {
    return this.enqueue(() => this.removeMessage(a.ts, a.stopKey));
  }

  /** The turn posted something else in the thread (e.g. send_message): the open message can't take a reply anymore. */
  notePostBelow(): void {
    if (this.started) this.passed = true;
  }

  /** The reply was posted as a message of its own: remove the activity message. */
  discard(): Promise<void> {
    this.cancelPending();
    return this.enqueue(() => this.remove());
  }

  /** End of turn: remove an activity message no reply adopted, and show nothing more. Idempotent. */
  close(): Promise<void> {
    this.disabled = true;
    return this.discard();
  }

  private cancelPending() {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private flushSoon(delayMs: number) {
    if (delayMs <= 0) {
      void this.enqueue(() => this.flush());
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(() => this.flush());
    }, delayMs);
  }

  private async flush(): Promise<void> {
    const text = this.pending;
    this.pending = null;
    if (this.disabled || this.broken || text == null) return;
    const last = this.cards.at(-1);
    if (last?.title === text || this.cards.length >= MAX_CARDS) return;
    if (this.t.stopRequested && (await this.t.stopRequested().catch(() => false))) {
      this.disabled = true; // the user pressed stop: show nothing more (close() removes what is there)
      return;
    }
    const next = { id: `activity-${this.cards.length + 1}`, title: text };
    const chunks = [...(last ? [card(last.id, last.title, 'complete')] : []), card(next.id, next.title, 'in_progress')];
    try {
      if (!this.ts) {
        this.started = true;
        const team = await this.t.teamId();
        const res = await slackCall<any>(
          'chat.startStream',
          {
            channel: this.t.channelId,
            thread_ts: this.t.threadTs,
            chunks,
            recipient_user_id: this.t.recipientUserId,
            ...(team ? { recipient_team_id: team } : {}),
          },
          { idempotencyKey: this.key() },
        );
        if (!res?.ts) throw new Error('chat.startStream returned no ts');
        this.ts = res.ts;
        await this.hook(() => this.t.onOpened?.(res.ts));
      } else {
        await slackCall('chat.appendStream', { channel: this.t.channelId, ts: this.ts, chunks });
      }
      this.cards.push(next);
      this.lastSentAt = Date.now();
    } catch (err) {
      if (this.ts) {
        this.broken = true;
        log.info({ code: slackErrorCode(err), turnId: this.t.turnId }, 'activity update failed; no more activity in this message');
      } else {
        // Slack refused a stream that holds only task cards: no activity text this turn ("Working…" still shows).
        this.disabled = true;
        this.started = false;
        log.warn({ err, code: slackErrorCode(err), turnId: this.t.turnId }, 'opening the activity message failed; activity text off for this turn');
      }
    }
  }

  private key(suffix = '') {
    return `activity:${this.t.turnId}:${this.opened}${suffix}`;
  }

  /** Stop and delete the open activity message, if any. */
  private async remove(): Promise<void> {
    const ts = this.ts;
    const key = this.key(':stop');
    this.reset();
    if (!ts) return;
    await this.removeMessage(ts, key);
    await this.hook(() => this.t.onClosed?.());
  }

  private async hook(fn: () => Promise<void> | undefined): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.debug({ err, turnId: this.t.turnId }, 'activity registry hook failed');
    }
  }

  private async removeMessage(ts: string, key: string): Promise<void> {
    try {
      await slackCall('chat.stopStream', { channel: this.t.channelId, ts }, { idempotencyKey: key });
      this.t.onSessionReleased?.();
    } catch (err) {
      log.debug({ code: slackErrorCode(err) }, 'stopping the activity message failed (already stopped?)');
    }
    try {
      await slackCall('chat.delete', { channel: this.t.channelId, ts });
    } catch (err) {
      log.warn({ err, code: slackErrorCode(err), ts }, 'deleting the activity message failed');
    }
  }

  private reset() {
    if (this.ts || this.started) this.opened++;
    this.ts = null;
    this.cards = [];
    this.started = false;
    this.broken = false;
    this.passed = false;
  }
}
