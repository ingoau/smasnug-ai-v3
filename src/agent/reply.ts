/**
 * Reply delivery. Code decides stream vs. post (`chooseDelivery`): streamed replies are forwarded live from the
 * reply tool's streamed arguments (tool input deltas → partial-JSON → chat.appendStream); otherwise the reply is
 * posted whole. The model's text is delivered as written (slack-markdown.ts): prose as `markdown` blocks, fenced
 * code as `rich_text` preformatted blocks (Slack's markdown converter would rewrite HTML tags inside code).
 * Streams run in `chunks` mode (a stream's mode is fixed at chat.startStream): prose goes out as `markdown_text`
 * chunks; a code block is held until its fence closes and then sent as a `blocks` chunk. A streamed reply that
 * carried blocks chunks is re-rendered with chat.update after stopStream, so its final layout is exactly the
 * posted one whatever Slack does with streamed blocks. Files are uploaded after the message (after stopStream).
 * Quick-reply buttons (reply-buttons.ts) go into the same message: an actions block in the post, or `blocks` on
 * chat.stopStream ("rendered at the bottom of the finalized message"); if that fails, chat.update adds them, and as
 * a last resort they are posted as a small follow-up message.
 * Tool activity ("Searching Slack…") shows live as the tasks of a plan in an activity message (activity-trail.ts). A
 * reply adopts that message: a streamed reply streams into it, a posted one is written into it (chat.update). The
 * final layout is [plan card, reply, buttons]: the turn's card (turn-card.ts; its steps and runs, collapsed once
 * done) or none for a turn without lookups or subagents. One card per message. No task is ever left in progress
 * when a stream stops (Slack would show it as failed).
 */
import { appendEvent } from '../core/events.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';
import type { TurnTiming } from '../core/timing.js';
import { uploadFiles, type OutgoingFile } from './files.js';
import { extractPartialString } from './partial-json.js';
import { broadcastSafePrefix, neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { chooseDelivery, type DeliveryMode } from './util.js';
import { buttonsActions, buttonsFallbackText, normalizeButtonLabels, type ButtonsActionsBlock } from './reply-buttons.js';
import { MAX_MESSAGE_BLOCKS, mdDisplay, replyMessage, segmentBlock, streamUnits } from './slack-markdown.js';
import { createReplyButtons, setButtonsMessage, toButtonsState, type ReplyButtonsRow } from './reply-buttons-store.js';
import { ActivityTrail, type AdoptedActivity } from './activity-trail.js';
import { forgetOpenActivity, recordOpenActivity } from './activity-registry.js';

/** Coalescing interval for appends once the stream is open. */
const FLUSH_MS = 250;
/** Before the stream is open: open it as soon as this many characters of text are there… */
const FIRST_FLUSH_CHARS = 8;
/** …or after this long, whichever comes first. */
const FIRST_FLUSH_MS = 80;
const MAX_MD = 11_500; // markdown limit: 12k chars cumulative per message / per stream call
/** Blocks a stream may carry (50 per message, one kept free for the buttons at stopStream). */
const MAX_STREAM_BLOCKS = MAX_MESSAGE_BLOCKS - 1;
/** A later reply in a turn is held back until this many chars arrived, so it can be checked for duplication first. */
export const EMPTY_RESULT = 'Not posted: the reply was empty. To stay silent, call end_turn.';

export interface ReplyTarget {
  threadId: string;
  channelId: string;
  threadTs: string;
  turnId: number;
  turnKind: 'user' | 'synthesis' | 'scheduled';
  /** Recipient for streams outside DMs. */
  recipientUserId: string;
  /** Count of queued/running runs in the thread right now. */
  activeRuns: () => Promise<number>;
  /** True once the turn was stopped (`!stop`): nothing more gets delivered. */
  stopRequested?: () => Promise<boolean>;
  /** Latency instrumentation: first reply delta, stream start/stop, post. */
  timing?: TurnTiming;
  /** Show tool activity as transient task cards in the reply message (STATUS_ACTIVITY_MODE=tasks). */
  activityCards?: boolean;
  /** chat.stopStream set the session `active` (its default): the pipeline re-sets `processing` on the next activity. */
  onSessionReleased?: () => void;
  /** True if a message was posted in the thread after `ts` (then a reply doesn't stream into that activity message). */
  postedSince?: (ts: string) => Promise<boolean>;
  /** A reply was delivered (its last message's ts, the text, whether it carries quick-reply buttons). Awaited, must not throw. */
  onDelivered?: (r: { ts: string | null; text: string; buttons: boolean }) => Promise<void>;
  /**
   * The turn's plan card (one per message, turn-card.ts): `block` gives the card to show above a reply that is about
   * to go out (null: no card, or it already lives in another message); `attached` records the message it went into.
   */
  card?: { block(): Promise<CardBlock | null>; attached(ts: string, text: string): Promise<void> };
}

/** The plan card as one block (a plan, or its collapsed line). */
export type CardBlock = { type: 'plan' | 'context'; block_id?: string };

/**
 * Stream errors meaning Slack is no longer streaming this message (e.g. stopped by the user). `stopped_by_user` too:
 * a frozen stream must never be rewritten (there is no native stop button any more, but a stream Slack halted for any
 * reason stays as it is).
 */
export const HALTED_STREAM = /stream|not_in_streaming_state|stopped_by_user/;
const isHalted = (code: string | undefined) => Boolean(code && code !== 'streaming_mode_mismatch' && HALTED_STREAM.test(code));
const STOPPED_RESULT = 'Not delivered: the user pressed stop. Do not retry; call end_turn.';

interface ReplyEntry {
  index: number;
  mode: Promise<DeliveryMode>;
  buf: string;
  /** Stream progress over the (neutralised) reply text, see slack-markdown streamUnits. */
  unitIdx: number;
  /** Of the current markdown unit: raw chars and displayed chars already sent. */
  mdRaw: number;
  mdShown: number;
  /** Markdown chars and blocks sent so far (Slack limits). */
  mdTotal: number;
  blockCount: number;
  /** Blocks chunks sent (code / rich paragraphs): the message gets its final layout via chat.update. */
  blocksChunks: number;
  /** Activity task cards in this message (adopted from the activity trail): dropped by the final layout. */
  activityCards: number;
  /** Offset in the reply text up to which everything is visible. */
  rawSent: number;
  /** The text visible in the stream so far (`text.slice(0, rawSent)`). */
  streamed: string;
  /** The rest doesn't fit into the stream (Slack limits): it is posted as its own message. */
  overflow: boolean;
  streamTs: string | null;
  stopped: boolean;
  chain: Promise<void>;
  timer: NodeJS.Timeout | null;
  failed: boolean;
  /** Slack stopped the stream itself (stopped by the user / stop request): never post the rest. */
  halted: boolean;
  /** Not delivered (duplicate / blocked): the model-facing reason. */
  dropped: string | null;
  /** The reply tool executed (finish() ran), or the turn closed the entry (closeUnfinished). */
  finished: boolean;
  /** Being posted whole (or posted): no new activity message may open above it. */
  posting: boolean;
}

/**
 * chat.update / chat.delete errors worth a short retry: right after chat.stopStream the message may still count as
 * streaming ("streaming_state_conflict: The message is currently streaming text and cannot be edited",
 * https://docs.slack.dev/reference/methods/chat.update), or Slack had a transient failure (no code: network).
 */
const RETRYABLE_EDIT = new Set(['streaming_state_conflict', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'ratelimited']);
/** Backoff between attempts (tests shorten it). */
export const editRetry = { delaysMs: [300, 1000] };

/** A chat.update / chat.delete of a reply message, retried briefly on transient errors. Throws the last error. */
async function editMessage(method: 'chat.update' | 'chat.delete', args: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await slackCall(method, args);
      return;
    } catch (err) {
      const code = slackErrorCode(err);
      const delay = editRetry.delaysMs[attempt];
      if (delay === undefined || (code !== undefined && !RETRYABLE_EDIT.has(code))) throw err;
      log.debug({ code, method, attempt }, 'editing a reply message failed; retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

let teamIdCache: string | undefined;
async function teamId(): Promise<string | undefined> {
  if (!teamIdCache) {
    try {
      const res = await slackCall<any>('auth.test', {});
      teamIdCache = res.team_id;
    } catch (err) {
      log.warn({ err }, 'auth.test failed');
    }
  }
  return teamIdCache;
}

/** A reply as a message payload (one block kept free for the quick-reply buttons). */
export function markdownMessage(text: string) {
  return replyMessage(text, { maxBlocks: MAX_MESSAGE_BLOCKS - 1 });
}

/** A reply message's final layout: [plan card, reply, buttons] (card and buttons when given). */
function replyLayout(text: string, actions?: ButtonsActionsBlock, card?: CardBlock | null): { text: string; blocks: unknown[] } {
  const msg = replyMessage(text, { maxBlocks: MAX_MESSAGE_BLOCKS - 1 - (card ? 1 : 0) });
  return { text: msg.text, blocks: [...(card ? [card] : []), ...msg.blocks, ...(actions ? [actions] : [])] };
}

export class ReplyManager {
  private entries = new Map<string, ReplyEntry>();
  private nextIndex = 0;
  /** Number of replies successfully delivered this turn. */
  delivered = 0;
  /** Texts of the replies delivered this turn (for duplicate detection). */
  private deliveredTexts: string[] = [];
  /** The last reply message delivered this turn (the plan card attaches to it). */
  lastDelivered: { ts: string; text: string; streamed: boolean } | null = null;
  private readonly trail: ActivityTrail | null;

  constructor(private readonly t: ReplyTarget) {
    this.trail = t.activityCards
      ? new ActivityTrail({
          channelId: t.channelId,
          threadTs: t.threadTs,
          turnId: t.turnId,
          recipientUserId: t.recipientUserId,
          teamId,
          stopRequested: t.stopRequested,
          onSessionReleased: t.onSessionReleased,
          onOpened: (ts) => recordOpenActivity(t.turnId, t.channelId, ts),
          onClosed: () => forgetOpenActivity(t.turnId),
        })
      : null;
  }

  /**
   * A tool that commits the turn to work started (code-derived label): show it as an activity card. Never blocks.
   * Not once a reply is visible: a new activity message would appear below the reply (and flash away again).
   */
  activity(text: string, toolCallId?: string): void {
    if (this.anyVisible) return;
    this.trail?.activity(text, toolCallId);
  }

  /** A tool call returned (`ok` false only if it threw): its activity card is finished (complete / error). */
  activityDone(toolCallId: string, ok = true): void {
    this.trail?.toolDone(toolCallId, ok);
  }

  /** End of turn: delete an activity message no reply took over (silent turn, error, stop). Never throws. */
  async closeActivity(): Promise<void> {
    await this.trail?.close().catch((err) => log.warn({ err }, 'closing the activity trail failed'));
  }

  /** True if any reply has started becoming visible (a stream started or a message posted). */
  get anyVisible() {
    return this.delivered > 0 || [...this.entries.values()].some((e) => e.streamTs || e.posting);
  }

  /** True once a reply has been attempted this turn (in progress or delivered, not dropped). */
  get attempted() {
    return [...this.entries.values()].some((e) => !e.dropped);
  }

  start(toolCallId: string): ReplyEntry {
    let e = this.entries.get(toolCallId);
    if (e) return e;
    const mode = this.t.activeRuns().then(
      (n) => chooseDelivery({ turnKind: this.t.turnKind, runningRuns: n }),
      () => 'post' as const,
    );
    e = {
      index: this.nextIndex++,
      mode,
      buf: '',
      unitIdx: 0,
      mdRaw: 0,
      mdShown: 0,
      mdTotal: 0,
      blockCount: 0,
      blocksChunks: 0,
      activityCards: 0,
      rawSent: 0,
      streamed: '',
      overflow: false,
      streamTs: null,
      stopped: false,
      chain: Promise.resolve(),
      timer: null,
      failed: false,
      halted: false,
      dropped: null,
      finished: false,
      posting: false,
    };
    this.entries.set(toolCallId, e);
    return e;
  }

  delta(toolCallId: string, d: string) {
    const e = this.start(toolCallId);
    this.t.timing?.mark('first_reply_delta');
    e.buf += d;
    if (this.t.timing && !('first_reply_text' in this.t.timing.marks) && (extractPartialString(e.buf, 'text')?.value ?? '').trim()) this.t.timing.mark('first_reply_text');
    // First reply of the turn, stream not open yet: open it as soon as a few words are there (then coalesce).
    const opening = !e.streamTs && this.deliveredTexts.length === 0;
    if (opening && e.timer) {
      if ((extractPartialString(e.buf, 'text')?.value ?? '').trim().length < FIRST_FLUSH_CHARS) return;
      clearTimeout(e.timer);
      e.timer = null;
    }
    if (!e.timer) {
      const ready = opening && (extractPartialString(e.buf, 'text')?.value ?? '').trim().length >= FIRST_FLUSH_CHARS;
      e.timer = setTimeout(
        () => {
          e.timer = null;
          e.chain = e.chain.then(() => this.flush(e)).catch((err) => this.onStreamError(e, err));
        },
        opening ? (ready ? 0 : FIRST_FLUSH_MS) : FLUSH_MS,
      );
    }
  }

  private key(e: ReplyEntry, suffix = '') {
    return `reply:${this.t.turnId}:${e.index}${suffix}`;
  }

  /**
   * Send what is newly streamable (see slack-markdown streamUnits) as chunks: markdown text as `markdown_text`
   * chunks, finished code blocks / rich paragraphs as `blocks` chunks. `finalText`: the complete reply.
   */
  private async flush(e: ReplyEntry, finalText?: string) {
    if (e.failed || e.stopped || e.halted || e.dropped || e.overflow) return;
    this.t.timing?.mark('first_flush');
    if ((await e.mode) !== 'stream') return;
    // Group pings (@channel/@here/@everyone, user groups) are neutralised: the bot never notifies a group.
    const base = finalText ?? broadcastSafePrefix(extractPartialString(e.buf, 'text')?.value ?? '');
    const units = streamUnits(base, finalText !== undefined);
    const chunks: ({ type: 'markdown_text'; text: string } | { type: 'blocks'; blocks: unknown[] })[] = [];
    const st = { unitIdx: e.unitIdx, mdRaw: e.mdRaw, mdShown: e.mdShown, mdTotal: e.mdTotal, blockCount: e.blockCount, blocksChunks: e.blocksChunks, rawSent: e.rawSent, overflow: false };
    for (let i = st.unitIdx; i < units.length; i++) {
      const u = units[i]!;
      if (u.kind === 'md') {
        const raw = base.slice(u.start, u.end);
        const shown = mdDisplay(raw);
        const piece = shown.slice(st.mdShown);
        if (piece.trim()) {
          const newBlock = st.mdShown === 0;
          if (st.mdTotal + piece.length > MAX_MD || (newBlock && st.blockCount >= MAX_STREAM_BLOCKS)) {
            st.overflow = true;
            break;
          }
          chunks.push({ type: 'markdown_text', text: piece });
          st.mdTotal += piece.length;
          if (newBlock) st.blockCount++;
          st.mdShown = shown.length;
          st.mdRaw = raw.length;
          st.rawSent = u.start + raw.length;
        }
        if (i === units.length - 1) break; // may still grow
        st.unitIdx = i + 1;
        st.mdRaw = 0;
        st.mdShown = 0;
        st.rawSent = u.end;
        continue;
      }
      if (st.blockCount >= MAX_STREAM_BLOCKS) {
        st.overflow = true;
        break;
      }
      chunks.push({ type: 'blocks', blocks: [segmentBlock(u.seg)] });
      st.blockCount++;
      st.blocksChunks++;
      st.unitIdx = i + 1;
      st.rawSent = u.end;
    }
    if (chunks.length) {
      if (await this.isStopped()) {
        // Native stop: Slack halted (or will halt) the stream; send nothing more.
        e.halted = Boolean(e.streamTs);
        e.failed = true;
        return;
      }
      let adopted = !e.streamTs && this.trail ? await this.trail.adopt() : null;
      if (adopted && (await this.postedSince(adopted.ts))) {
        // Messages arrived below the activity message: the reply goes below them, in a message of its own.
        await this.trail!.dropAdopted(adopted);
        adopted = null;
      }
      if (adopted && (await this.streamInto(e, adopted, chunks))) {
        // The activity message was open: the reply streams into it, below its cards (marked complete now).
        e.streamTs = adopted.ts;
        e.activityCards = adopted.cards;
        st.blockCount += adopted.cards;
      } else if (!e.streamTs) {
        const team = await teamId();
        this.t.timing?.mark('stream_open_call');
        // Opened in chunks mode, so markdown text and blocks can be mixed for the whole stream.
        const res = await slackCall<any>(
          'chat.startStream',
          {
            channel: this.t.channelId,
            thread_ts: this.t.threadTs,
            chunks,
            recipient_user_id: this.t.recipientUserId,
            ...(team ? { recipient_team_id: team } : {}),
          },
          { idempotencyKey: this.key(e) },
        );
        e.streamTs = res.ts ?? null;
        this.t.timing?.mark('stream_started');
        if (!e.streamTs) throw new Error('chat.startStream returned no ts');
      } else {
        await slackCall('chat.appendStream', { channel: this.t.channelId, ts: e.streamTs, chunks });
      }
    }
    Object.assign(e, st);
    e.streamed = base.slice(0, e.rawSent);
  }

  /**
   * Open the reply in the adopted activity message. False when it can't take the reply (Slack already ended its
   * stream, e.g. after a long tool call): the message is deleted and the reply opens a fresh stream. A user stop is
   * re-thrown (the entry then counts as halted, and finish() removes the message).
   */
  private async streamInto(e: ReplyEntry, adopted: AdoptedActivity, chunks: unknown[]): Promise<boolean> {
    try {
      this.t.timing?.mark('stream_open_call');
      await slackCall('chat.appendStream', { channel: this.t.channelId, ts: adopted.ts, chunks: [...adopted.chunks, ...chunks] });
      this.t.timing?.mark('stream_started');
      return true;
    } catch (err) {
      if (await this.isStopped()) {
        e.streamTs = adopted.ts;
        e.activityCards = adopted.cards;
        throw err;
      }
      log.info({ code: slackErrorCode(err), turnId: this.t.turnId }, 'the activity message cannot take the reply; opening a fresh one');
      await this.trail?.dropAdopted(adopted);
      return false;
    }
  }

  private async onStreamError(e: ReplyEntry, err: unknown) {
    e.failed = true;
    const code = slackErrorCode(err);
    // Only a confirmed user stop counts as halted: Slack also ends streams by itself (e.g. one left idle while a
    // tool ran), and then the reply must still be delivered (recoverStream / post).
    if (e.streamTs && isHalted(code) && (await this.isStopped())) {
      e.halted = true;
      log.info({ code, index: e.index }, 'reply stream halted by Slack (stopped?)');
    } else {
      log.warn({ err, index: e.index }, 'reply stream failed; will fall back to posting');
    }
  }

  private async postedSince(ts: string): Promise<boolean> {
    return this.t.postedSince ? this.t.postedSince(ts).catch((err) => (log.warn({ err }, 'postedSince check failed'), false)) : false;
  }

  /** The turn posted something else in the thread (send_message): an open activity message can't take a reply now. */
  notePostedInThread(): void {
    this.trail?.notePostBelow();
  }

  private async isStopped(): Promise<boolean> {
    return this.t.stopRequested ? this.t.stopRequested().catch(() => false) : false;
  }

  /** Called from the tool's execute with the complete, validated input. */
  async finish(toolCallId: string, rawText: string, files?: OutgoingFile[], buttons?: readonly string[]): Promise<string> {
    const e = this.start(toolCallId);
    e.finished = true;
    const text = neutralizeBroadcasts(rawText);
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    await e.chain.catch(() => {});
    if (e.halted || (await this.isStopped())) {
      // Close our side quietly (Slack may already have stopped it) and deliver nothing else.
      if (e.streamTs) await this.stopStream(e).catch((err) => log.debug({ err }, 'stopStream after stop failed'));
      await this.dropActivityCards(e, e.streamed);
      await appendEvent(this.t.threadId, 'reply', 'bot', { turnId: this.t.turnId, index: e.index, stopped: true, streamed: e.streamed });
      return STOPPED_RESULT;
    }
    if (!e.streamTs) {
      // Nothing visible yet: an empty reply has nothing to post (Slack rejects empty messages).
      const reason = !text.trim() && !files?.length ? EMPTY_RESULT : null;
      if (reason) {
        e.dropped = reason;
        await appendEvent(this.t.threadId, 'reply_dropped', 'bot', { turnId: this.t.turnId, index: e.index, reason, text });
        return reason;
      }
    }
    const mode = await e.mode;
    // Quick-reply buttons: the row id goes into the button values, so it exists before the message does.
    const labels = normalizeButtonLabels(buttons);
    let btnRow: ReplyButtonsRow | null = null;
    if (labels.length) {
      btnRow = await createReplyButtons({ threadId: this.t.threadId, channelId: this.t.channelId, turnId: this.t.turnId, key: this.key(e), labels }).catch((err) => {
        log.warn({ err }, 'creating reply buttons failed; replying without them');
        return null;
      });
    }
    const actions = btnRow ? buttonsActions(btnRow) : undefined;
    /** The message that ended up carrying the buttons (set when they went out with it). */
    let buttonsTs: string | null = null;
    let delivered: 'streamed' | 'posted' = 'posted';
    let last: { ts: string | null; text: string } = { ts: null, text };
    if (mode === 'stream' && !e.failed) {
      try {
        // Nothing streamed yet but an activity message is open: stream into it (same result as posting whole).
        if (!e.streamTs && this.trail?.isOpen) await this.flush(e, text);
        if (e.streamTs) {
          if (!text.startsWith(e.streamed)) {
            log.warn({ index: e.index }, 'streamed prefix diverged from final reply text');
          }
          await this.flush(e, text);
          delivered = 'streamed';
          if (e.overflow) {
            // Too long for one message: close the stream and post the rest as its own message.
            await this.stopStream(e);
            await this.dropActivityCards(e, e.streamed);
            last = { ts: e.streamTs, text: e.streamed };
            const rest = text.slice(e.rawSent);
            if (rest.trim()) {
              last = { ts: await this.post(e, rest, ':rest', actions), text: rest };
              buttonsTs = last.ts;
            }
          } else {
            if (await this.stopStreamWithButtons(e, actions)) buttonsTs = e.streamTs;
            // The final layout keeps the turn's plan card above the reply (the live plan's tasks become the card).
            const card = await this.cardBlock();
            if (card || e.blocksChunks > 0 || e.activityCards > 0) {
              if (await this.finalLayout(e, text, actions, card)) {
                if (actions) buttonsTs = e.streamTs;
                if (card) await this.attachCard(e.streamTs!, text);
              }
            }
            last = { ts: e.streamTs, text };
          }
        } else {
          // Nothing streamed yet (no deltas, or all of it held back): post whole, same visual result.
          last = { ts: await this.postWhole(e, text, actions), text };
          buttonsTs = last.ts;
        }
      } catch (err) {
        log.warn({ err }, 'stream finish failed');
        if (e.streamTs) {
          delivered = 'streamed';
          ({ last, buttonsTs } = await this.recoverStream(e, text, actions));
        } else {
          last = { ts: await this.postWhole(e, text, actions), text };
          buttonsTs = last.ts;
        }
      }
    } else if (e.streamTs) {
      // Stream opened but failed: close it and complete the message.
      delivered = 'streamed';
      ({ last, buttonsTs } = await this.recoverStream(e, text, actions));
    } else {
      last = { ts: await this.postWhole(e, text, actions), text };
      buttonsTs = last.ts;
    }
    // Posted as a message of its own: postWhole removed the activity message first; one a tool running alongside
    // opened meanwhile goes too.
    if (delivered === 'posted') await this.trail?.discard().catch((err) => log.warn({ err }, 'discarding the activity message failed'));
    if (btnRow) await this.recordButtons(e, btnRow, buttonsTs && buttonsTs === last.ts ? buttonsTs : null, last);
    this.delivered++;
    if (last.ts) this.lastDelivered = { ts: last.ts, text: last.text, streamed: delivered === 'streamed' && last.ts === e.streamTs };
    this.deliveredTexts.push(text);
    await this.t.onDelivered?.({ ts: last.ts, text, buttons: Boolean(btnRow) }).catch((err) => log.warn({ err }, 'onDelivered failed'));
    if (files?.length) {
      try {
        await uploadFiles({ channelId: this.t.channelId, threadTs: this.t.threadTs, files, idempotencyKey: this.key(e, ':files') });
      } catch (err) {
        log.warn({ err }, 'reply file upload failed');
        await appendEvent(this.t.threadId, 'reply', 'bot', { turnId: this.t.turnId, index: e.index, mode: delivered, text, filesError: String(err) });
        return `Replied (${delivered}), but uploading the files failed.`;
      }
    }
    await appendEvent(this.t.threadId, 'reply', 'bot', {
      turnId: this.t.turnId,
      index: e.index,
      mode: delivered,
      text,
      files: files?.map((f) => (f.fileId ? `${f.fileId} (${f.filename})` : f.filename)),
      ...(btnRow ? { buttons: btnRow.labels } : {}),
    });
    return `Replied (${delivered})${btnRow ? ` with buttons: ${btnRow.labels.join(' | ')}` : ''}.`;
  }

  private async post(e: ReplyEntry, text: string, suffix = '', actions?: ButtonsActionsBlock, card?: CardBlock | null): Promise<string | null> {
    const msg = replyLayout(text, actions, card);
    const res = await slackCall<any>(
      'chat.postMessage',
      { channel: this.t.channelId, thread_ts: this.t.threadTs, text: msg.text, blocks: msg.blocks, unfurl_links: false },
      { idempotencyKey: this.key(e, suffix) },
    );
    this.t.timing?.mark('reply_posted');
    return res?.ts ?? null;
  }

  /** The turn's card for a reply about to go out (null: none). Never throws. */
  private async cardBlock(): Promise<CardBlock | null> {
    if (!this.t.card) return null;
    return this.t.card.block().catch((err) => (log.warn({ err }, 'rendering the plan card for the reply failed'), null));
  }

  private async attachCard(ts: string, text: string): Promise<void> {
    await this.t.card?.attached(ts, text).catch((err) => log.warn({ err }, 'recording the plan card message failed'));
  }

  /**
   * Post the reply whole (e.g. subagents running), with the turn's plan card above it. An open activity message
   * becomes the reply (its live plan turns into the card): its stream is stopped with every task finished and the
   * message rewritten (chat.update). If it can't take the reply (something was posted below it, Slack refused the
   * update), it is deleted first and the reply posted as a new message, so the cards never sit above it for a moment.
   * No new activity message opens from here on (`posting` counts as visible).
   */
  private async postWhole(e: ReplyEntry, text: string, actions?: ButtonsActionsBlock): Promise<string | null> {
    e.posting = true;
    try {
      const card = await this.cardBlock();
      const ts = (await this.postIntoActivity(text, actions, card)) ?? (await this.post(e, text, '', actions, card));
      if (ts && card) await this.attachCard(ts, text);
      return ts;
    } catch (err) {
      e.posting = false;
      throw err;
    }
  }

  /** The reply rewritten into the open activity message (see postWhole); null when there is none or it had to go. */
  private async postIntoActivity(text: string, actions: ButtonsActionsBlock | undefined, card: CardBlock | null): Promise<string | null> {
    if (!this.trail?.isOpen) {
      await this.trail?.discard().catch((err) => log.warn({ err }, 'discarding the activity message failed'));
      return null;
    }
    const a = await this.trail.adopt();
    if (!a) return null;
    if (!(await this.postedSince(a.ts))) {
      try {
        await slackCall('chat.stopStream', { channel: this.t.channelId, ts: a.ts, ...(a.chunks.length ? { chunks: a.chunks } : {}) }, { idempotencyKey: a.stopKey });
        this.t.onSessionReleased?.();
        await editMessage('chat.update', { channel: this.t.channelId, ts: a.ts, ...replyLayout(text, actions, card) });
        this.t.timing?.mark('reply_posted');
        return a.ts;
      } catch (err) {
        log.info({ code: slackErrorCode(err), turnId: this.t.turnId }, 'the activity message cannot take the posted reply; posting a new one');
      }
    }
    await this.trail.dropAdopted(a);
    return null;
  }

  /**
   * A stream that failed midway (not stopped by the user): close it, then replace its content with the whole reply
   * (chat.update, one message). If that fails too, post the part that wasn't visible yet as its own message.
   */
  private async recoverStream(e: ReplyEntry, text: string, actions?: ButtonsActionsBlock): Promise<{ last: { ts: string | null; text: string }; buttonsTs: string | null }> {
    await this.stopStream(e).catch((err) => log.debug({ err }, 'stopStream after failure failed'));
    try {
      const msg = markdownMessage(text);
      await editMessage('chat.update', { channel: this.t.channelId, ts: e.streamTs, text: msg.text, blocks: actions ? [...msg.blocks, actions] : msg.blocks });
      return { last: { ts: e.streamTs, text }, buttonsTs: actions ? e.streamTs : null };
    } catch (err) {
      log.warn({ err, code: slackErrorCode(err), index: e.index }, 'completing a failed stream via chat.update failed; posting the rest');
    }
    const rest = text.slice(e.rawSent);
    if (!rest.trim()) return { last: { ts: e.streamTs, text: e.streamed }, buttonsTs: null };
    const ts = await this.post(e, rest, ':rest', actions);
    return { last: { ts, text: rest }, buttonsTs: ts };
  }

  /**
   * After a stream that carried blocks chunks, activity tasks or gets the turn's card: re-render the finished message
   * with the posted layout ([card], prose as markdown, code as rich_text, in order, [buttons]), so it ends up exactly
   * like a posted reply. Returns false (logged) when Slack refused it. Never throws.
   */
  private async finalLayout(e: ReplyEntry, text: string, actions?: ButtonsActionsBlock, card?: CardBlock | null): Promise<boolean> {
    try {
      await editMessage('chat.update', { channel: this.t.channelId, ts: e.streamTs, ...replyLayout(text, actions, card) });
      return true;
    } catch (err) {
      log.warn({ err, code: slackErrorCode(err), index: e.index }, 'final layout update of a streamed reply failed; keeping the streamed layout');
      return false;
    }
  }

  private async stopStream(e: ReplyEntry, extra?: string, blocks?: unknown[], suffix = ':stop') {
    if (!e.streamTs || e.stopped) return;
    e.stopped = true;
    await slackCall(
      'chat.stopStream',
      // The stream runs in chunks mode: extra text must be a chunk too (mixing modes → streaming_mode_mismatch).
      { channel: this.t.channelId, ts: e.streamTs, ...(extra ? { chunks: [{ type: 'markdown_text', text: extra }] } : {}), ...(blocks?.length ? { blocks } : {}) },
      { idempotencyKey: this.key(e, suffix) },
    );
    this.t.timing?.mark('stream_stopped');
    this.t.onSessionReleased?.();
  }

  /**
   * A message that carried activity cards but ends without the normal final layout (stop, overflow, error): show
   * just its visible text (chat.update), or delete it if no text is visible. Never throws.
   */
  private async dropActivityCards(e: ReplyEntry, text: string) {
    if (!e.activityCards || !e.streamTs) return;
    try {
      if (text.trim()) await editMessage('chat.update', { channel: this.t.channelId, ts: e.streamTs, ...markdownMessage(text) });
      else await editMessage('chat.delete', { channel: this.t.channelId, ts: e.streamTs });
    } catch (err) {
      log.warn({ err, code: slackErrorCode(err), index: e.index }, 'removing activity cards from a reply failed');
    }
  }

  /**
   * Finalise a stream, with the buttons as `blocks` (chat.stopStream renders them at the bottom of the finalized
   * message). If Slack refuses that, stop it without them (recordButtons then attaches them another way).
   * Returns true when the buttons went out with the stop.
   */
  private async stopStreamWithButtons(e: ReplyEntry, actions?: ButtonsActionsBlock): Promise<boolean> {
    if (!actions) {
      await this.stopStream(e);
      return false;
    }
    try {
      await this.stopStream(e, undefined, [actions]);
      return true;
    } catch (err) {
      log.warn({ err, code: slackErrorCode(err), index: e.index }, 'chat.stopStream with buttons failed; stopping without them');
      e.stopped = false;
      await this.stopStream(e, undefined, undefined, ':stop-plain');
      return false;
    }
  }

  /**
   * Remember which message carries the buttons. When they didn't go out with the reply (stopStream refused them,
   * or a fallback path), add them to the delivered message with chat.update; failing that, post them as a small
   * follow-up message. Never throws.
   */
  private async recordButtons(e: ReplyEntry, row: ReplyButtonsRow, sentWith: string | null, last: { ts: string | null; text: string }) {
    try {
      if (sentWith) {
        await setButtonsMessage(row.id, sentWith, last.text);
        return;
      }
      const actions = buttonsActions(row);
      if (last.ts) {
        try {
          const msg = markdownMessage(last.text);
          await editMessage('chat.update', { channel: this.t.channelId, ts: last.ts, text: msg.text, blocks: [...msg.blocks, actions] });
          await setButtonsMessage(row.id, last.ts, last.text);
          return;
        } catch (err) {
          log.warn({ err, code: slackErrorCode(err), ts: last.ts }, 'adding reply buttons via chat.update failed; posting them as a follow-up');
        }
      }
      const res = await slackCall<any>(
        'chat.postMessage',
        { channel: this.t.channelId, thread_ts: this.t.threadTs, text: buttonsFallbackText(toButtonsState(row)), blocks: [actions] },
        { idempotencyKey: this.key(e, ':buttons') },
      );
      if (res?.ts) await setButtonsMessage(row.id, res.ts, null);
    } catch (err) {
      log.warn({ err, buttonsId: row.id }, 'delivering reply buttons failed');
    }
  }

  /**
   * End of a turn (not stopped, not failed): close replies whose tool call never executed (e.g. invalid or cut-off
   * input, the model retrying with a new call). Nothing more is streamed for them; a stream they opened is deleted
   * when another reply was delivered (the retry), else it keeps just its visible text (activity cards dropped).
   * Never throws.
   */
  async closeUnfinished(): Promise<void> {
    for (const e of this.entries.values()) {
      if (e.finished) continue;
      e.finished = true;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      e.dropped ??= 'the reply tool call never executed';
      await e.chain.catch(() => {});
      if (!e.streamTs) continue;
      log.info({ index: e.index, turnId: this.t.turnId }, 'closing a reply stream whose tool call never executed');
      await this.stopStream(e).catch((err) => log.debug({ err }, 'stopStream of an unfinished reply failed'));
      try {
        if (this.delivered > 0 || !e.streamed.trim()) await editMessage('chat.delete', { channel: this.t.channelId, ts: e.streamTs });
        else await this.dropActivityCards(e, e.streamed);
      } catch (err) {
        log.warn({ err, code: slackErrorCode(err), index: e.index }, 'removing an unfinished reply stream failed');
      }
    }
  }

  /**
   * After `!stop` aborted the turn mid-reply (the reply tool never ran): close each stream it opened (Slack may
   * already have) keeping what was shown, and record it as a stopped reply, as finish() does. Never throws.
   */
  async closeStopped(): Promise<void> {
    for (const e of this.entries.values()) {
      if (e.finished) continue;
      e.finished = true;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      await e.chain.catch(() => {});
      if (!e.streamTs) continue;
      await this.stopStream(e).catch((err) => log.debug({ err }, 'stopStream after stop failed'));
      await this.dropActivityCards(e, e.streamed);
      await appendEvent(this.t.threadId, 'reply', 'bot', { turnId: this.t.turnId, index: e.index, stopped: true, streamed: e.streamed }).catch(() => {});
    }
  }

  /** On a model/API failure (or stop): close any open stream, with a short note if given. Returns true if one was open. */
  async abortOpenStreams(note?: string): Promise<boolean> {
    let any = false;
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer);
      await e.chain.catch(() => {});
      if (e.halted) {
        any = true; // visible, and Slack already stopped it
        await this.dropActivityCards(e, e.streamed);
        continue;
      }
      if (e.streamTs && !e.stopped) {
        any = true;
        await this.stopStream(e, note ? `\n\n${note}` : undefined).catch((err) => log.warn({ err }, 'stopStream failed'));
        await this.dropActivityCards(e, note ? `${e.streamed}\n\n${note}` : e.streamed);
      }
    }
    return any;
  }
}
