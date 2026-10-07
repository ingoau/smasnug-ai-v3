/**
 * Activity trail: the per-tool activity text ("Searching Slack…", "Reading the page…") as live tasks of the plan card
 * in the turn's reply message (`STATUS_ACTIVITY_MODE=tasks`).
 *
 * Why here: the only free-text status method, `assistant.threads.setStatus`, is deprecated (removal February 2027,
 * https://docs.slack.dev/changelog/2026/08/20/agent-updates/), and its replacement `agents.sessions.setStatus`
 * "does not accept a custom loading message" (https://docs.slack.dev/ai/agent-sessions/). The non-deprecated
 * progress surface is the streaming API: `task_update` chunks (`{ type, id, title, status }`, ≤ 256 chars,
 * https://docs.slack.dev/reference/methods/chat.startStream#task_update-chunks). The stream is opened with
 * `task_display_mode: 'plan'` ("task updates render together in a plan block") and a `plan_update` title, so the
 * tasks are the message's one plan card; if Slack refuses that, it falls back to `timeline` (task cards).
 *
 * How it works:
 * - The first activity of a turn opens a stream that holds only the plan with one task (in progress); later
 *   activities add tasks, coalesced to at most one update per second (latest text wins, unchanged text is skipped).
 *   Nothing is shown before the turn commits to work (same rule as the status).
 * - A task is finished when its tool calls return (`toolDone`): `complete`, or `error` only when a call really
 *   failed (the tool threw). A task without tracked calls is completed when the next one replaces it. A tool that
 *   returns before its task went out never shows one (e.g. an instant spawn_subagent).
 * - A task is never left `in_progress` when its stream stops: Slack renders a task that is still pending /
 *   in_progress when the stream ends as failed (a warning icon; Slack's docs don't say, observed on the dev app and
 *   by others, e.g. https://github.com/openclaw/openclaw/issues/146221). Adoption and every removal carry the
 *   chunks that finish all open tasks (`complete`, or `error` for a failed call), on chat.appendStream /
 *   chat.stopStream (which accepts `chunks`, https://docs.slack.dev/reference/methods/chat.stopStream).
 * - The turn's next reply adopts this message (ReplyManager): a streamed reply's text streams in below the plan, a
 *   reply posted whole is written into it (chat.update). The final layout renders the turn's plan card from the DB
 *   (turn-card.ts, card-render.ts: a plan of the steps and runs, every task final once done) above the reply, or no card at all for a
 *   turn without lookups or subagents. When anything was posted in the thread after the activity message (a user
 *   message, send_message, …), adopting it would put the reply above that post: it is deleted and the reply opens a
 *   message of its own.
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
/** The live plan's title (plan_update chunk) while the turn works; the reply's final layout renders the card. */
export const PLAN_TITLE = 'Working…';

/**
 * Slack task statuses (https://docs.slack.dev/reference/methods/chat.startStream#task_update-chunks): `in_progress`,
 * `complete`, `error`. A task still `in_progress` when its stream stops renders as failed, so every card is finished
 * before the stop (`complete` unless a call really failed).
 */
export type TaskStatus = 'in_progress' | 'complete' | 'error';

export interface TaskUpdateChunk {
  type: 'task_update';
  id: string;
  title: string;
  status: TaskStatus;
}

interface Card {
  id: string;
  title: string;
  status: TaskStatus;
  /** The status Slack has (null: not sent yet). */
  sent: TaskStatus | null;
  /** Tool calls behind this card still running; the card finishes when the last one returns. */
  running: Set<string>;
  /** Some call behind it was announced without an id: only the next card (or the end) finishes it. */
  untracked: boolean;
  failed: boolean;
}

interface Pending {
  title: string;
  calls: Set<string>;
  untracked: boolean;
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

/** What a reply takes over: the open message, plus the chunks that finish its open cards. */
export interface AdoptedActivity {
  ts: string;
  chunks: TaskUpdateChunk[];
  cards: number;
  /** Idempotency key for stopping it, should the reply not be able to use it after all (dropAdopted). */
  stopKey: string;
}

const chunk = (c: Card, status: TaskStatus = c.status): TaskUpdateChunk => ({ type: 'task_update', id: c.id, title: c.title, status });
/** The status a card ends with when its stream stops or a reply takes it over. */
const finalStatus = (c: Card): TaskStatus => (c.status === 'in_progress' ? (c.failed ? 'error' : 'complete') : c.status);

export class ActivityTrail {
  /** The open activity message (no reply has adopted it yet). */
  private ts: string | null = null;
  /** Cards in the open message (or being sent), in order. */
  private cards: Card[] = [];
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
  /** The next card (latest activity text wins until it goes out). */
  private pending: Pending | null = null;
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

  /**
   * A tool that commits the turn to work started: show / update its card. `callId` lets `toolDone` finish the card
   * when the call returns. Synchronous, never blocks.
   */
  activity(text: string, callId?: string): void {
    if (this.disabled || this.broken || !text) return;
    const title = text.slice(0, MAX_TITLE);
    const join = (into: { untracked: boolean }, calls: Set<string>) => {
      if (callId) calls.add(callId);
      else into.untracked = true;
    };
    if (this.pending?.title === title) {
      join(this.pending, this.pending.calls); // its flush is coming
      return;
    }
    const last = this.cards.at(-1);
    if (!this.pending && last?.title === title && last.status === 'in_progress') {
      join(last, last.running); // unchanged text: the call joins the current card
      return;
    }
    this.pending = { title, calls: new Set(callId ? [callId] : []), untracked: !callId };
    if (!this.started) {
      this.started = true;
      return this.flushSoon(0); // first activity: no delay
    }
    this.schedule();
  }

  /**
   * A tool call returned (`ok`: false only when it really failed, i.e. threw). When its card has no other call
   * running it is finished: `complete`, or `error` if a call failed. A call that returns before its card went out
   * shows no card at all. Synchronous, never blocks.
   */
  toolDone(callId: string, ok = true): void {
    if (this.pending?.calls.delete(callId)) {
      if (!this.pending.calls.size && !this.pending.untracked) this.pending = null;
      return;
    }
    const c = this.cards.find((k) => k.running.has(callId));
    if (!c) return;
    c.running.delete(callId);
    if (!ok) c.failed = true;
    if (c.running.size || c.untracked || c.status !== 'in_progress') return;
    c.status = finalStatus(c);
    if (this.ts && !this.disabled && !this.broken) this.schedule();
  }

  /**
   * A reply is about to open its stream: hand over the open activity message (null if there is none), with the
   * chunks that finish its open cards. The trail starts afresh, so activity after this reply opens a new message.
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
      const adopted: AdoptedActivity = { ts: this.ts, chunks: this.finishing(), cards: this.cards.length, stopKey: this.key(':stop') };
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
    return this.enqueue(() => this.removeMessage(a.ts, a.stopKey, a.chunks));
  }

  /** The turn posted something else in the thread (e.g. send_message): the open message can't take a reply anymore. */
  notePostBelow(): void {
    if (this.started) this.passed = true;
  }

  /** The reply is posted as a message of its own: remove the activity message. */
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

  /** Flush soon, at most one update per interval (the scheduled flush picks up the latest state). */
  private schedule() {
    if (this.timer) return;
    this.flushSoon(Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now()));
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

  /** Chunks that bring every card to its final status (none left in progress), for a stop or an adoption. */
  private finishing(): TaskUpdateChunk[] {
    return this.cards.filter((c) => finalStatus(c) !== c.sent).map((c) => chunk(c, finalStatus(c)));
  }

  /** Send what changed: the pending card (if any) and every card whose status Slack doesn't have yet. */
  private async flush(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (this.disabled || this.broken) return;
    const last = this.cards.at(-1);
    let next: Card | null = null;
    if (p && last?.title === p.title && last.status === 'in_progress') {
      p.calls.forEach((id) => last.running.add(id));
      if (p.untracked) last.untracked = true;
    } else if (p && this.cards.length < MAX_CARDS) {
      if (this.t.stopRequested && (await this.t.stopRequested().catch(() => false))) {
        this.disabled = true; // the user pressed stop: show nothing more (close() removes what is there)
        return;
      }
      // A card without tracked calls is done once the next one replaces it.
      for (const c of this.cards) if (c.status === 'in_progress' && (c.untracked || !c.running.size)) c.status = finalStatus(c);
      next = { id: `activity-${this.cards.length + 1}`, title: p.title, status: 'in_progress', sent: null, running: new Set(p.calls), untracked: p.untracked, failed: false };
    }
    if (!this.ts && !next) return; // status changes only matter in an open message
    if (next) this.cards.push(next);
    const sending = this.cards.filter((c) => c.status !== c.sent).map((c) => [c, c.status] as const);
    if (!sending.length) return;
    const chunks = sending.map(([c, s]) => chunk(c, s));
    try {
      if (!this.ts) {
        this.started = true;
        const team = await this.t.teamId();
        const open = (plan: boolean) =>
          slackCall<any>(
            'chat.startStream',
            {
              channel: this.t.channelId,
              thread_ts: this.t.threadTs,
              // Plan mode: the tasks render together in one plan block, the message's plan card (titled by plan_update).
              chunks: plan ? [{ type: 'plan_update', title: PLAN_TITLE }, ...chunks] : chunks,
              ...(plan ? { task_display_mode: 'plan' } : {}),
              recipient_user_id: this.t.recipientUserId,
              ...(team ? { recipient_team_id: team } : {}),
            },
            { idempotencyKey: this.key(plan ? '' : ':timeline') },
          );
        let res: any;
        try {
          res = await open(true);
        } catch (err) {
          if (!slackErrorCode(err)) throw err;
          // Slack refused the plan display: the same tasks as individual task cards (timeline, the default).
          log.info({ code: slackErrorCode(err), turnId: this.t.turnId }, 'plan-mode activity stream refused; opening it in timeline mode');
          res = await open(false);
        }
        if (!res?.ts) throw new Error('chat.startStream returned no ts');
        this.ts = res.ts;
        await this.hook(() => this.t.onOpened?.(res.ts));
      } else {
        await slackCall('chat.appendStream', { channel: this.t.channelId, ts: this.ts, chunks });
      }
      for (const [c, s] of sending) c.sent = s;
      this.lastSentAt = Date.now();
      // A call returned while this was on its way: its status goes with the next update.
      if (this.cards.some((c) => c.status !== c.sent)) this.schedule();
    } catch (err) {
      if (next && this.cards.at(-1) === next) this.cards.pop();
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

  /** Stop (every card finished) and delete the open activity message, if any. */
  private async remove(): Promise<void> {
    const ts = this.ts;
    const key = this.key(':stop');
    const chunks = this.finishing();
    this.reset();
    if (!ts) return;
    await this.removeMessage(ts, key, chunks);
    await this.hook(() => this.t.onClosed?.());
  }

  private async hook(fn: () => Promise<void> | undefined): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.debug({ err, turnId: this.t.turnId }, 'activity registry hook failed');
    }
  }

  /**
   * Stop the message, finishing its cards in the same call (a card still in progress when the stream stops would
   * render as failed until the delete lands), then delete it.
   */
  private async removeMessage(ts: string, key: string, chunks: TaskUpdateChunk[]): Promise<void> {
    try {
      await slackCall('chat.stopStream', { channel: this.t.channelId, ts, ...(chunks.length ? { chunks } : {}) }, { idempotencyKey: key });
      this.t.onSessionReleased?.();
    } catch (err) {
      const code = slackErrorCode(err);
      log.debug({ code }, 'stopping the activity message failed (already stopped?)');
      // Slack refused the chunks (not a stream that already ended): stop it plainly, the delete follows anyway.
      if (chunks.length && !/stream|stopped/.test(code ?? '')) {
        await slackCall('chat.stopStream', { channel: this.t.channelId, ts }, { idempotencyKey: `${key}-plain` }).then(
          () => this.t.onSessionReleased?.(),
          (e) => log.debug({ code: slackErrorCode(e) }, 'stopping the activity message without chunks failed'),
        );
      }
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
