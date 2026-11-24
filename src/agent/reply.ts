/**
 * Reply delivery. Code decides stream vs. post (`chooseDelivery`): streamed replies are forwarded live from the
 * reply tool's streamed arguments (tool input deltas → partial-JSON → chat.appendStream); otherwise the reply is
 * posted whole. The model's text is delivered as written (slack-markdown.ts): prose as `markdown` blocks, fenced
 * code as `rich_text` preformatted blocks (Slack's markdown converter would rewrite HTML tags inside code).
 * Streams run in `chunks` mode (a stream's mode is fixed at chat.startStream): prose goes out as `markdown_text`
 * chunks; a code block is held until its fence closes and then sent as a `blocks` chunk. A streamed reply that
 * carried blocks chunks is re-rendered with chat.update after stopStream, so its final layout is exactly the
 * posted one whatever Slack does with streamed blocks.
 * Quick-reply buttons (reply-buttons.ts) go into the same message: an actions block in the post, or `blocks` on
 * chat.stopStream ("rendered at the bottom of the finalized message"); if that fails, chat.update adds them, and as
 * a last resort they are posted as a small follow-up message.
 * Extra blocks (rich-blocks.ts: charts, inline images, data tables, link cards) sit between the reply and the buttons,
 * or inline where the text has a `[[kind:n]]` marker line (nothing is streamed for a marker). A streamed reply gets
 * them in the final chat.update (and on stopStream, so they show if that update fails). They are saved on the message
 * (reply_charts) before a plan card is attached, so a later re-render puts them back. If Slack refuses them
 * (invalid_blocks), the reply goes out degraded: their markdown fallbacks in the text, image files attached.
 * Files are uploaded privately and attached to the reply message itself (chat.update file_ids); if that fails they
 * are shared below it as before.
 * Tool activity ("Searching Slack…") shows live as the tasks of a plan in an activity message (activity-trail.ts). A
 * reply adopts that message: a streamed reply streams into it, a posted one is written into it (chat.update). The
 * final layout is [plan card, reply with its extras, buttons]: the turn's card (turn-card.ts; a plan block of its steps and runs,
 * which Slack shows collapsed to its title once the stream is over) or none for a turn without lookups or subagents. One card per message. No task is ever left in progress
 * when a stream stops (Slack would show it as failed).
 */
import { appendEvent, threadTsArg } from '../core/events.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';
import type { TurnTiming } from '../core/timing.js';
import { uploadFiles, uploadPrivateFiles, type OutgoingFile } from './files.js';
import { FileError, recordFilePosts } from '../files/store.js';
import { extractPartialString } from './partial-json.js';
import { broadcastSafePrefix, neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { chooseDelivery, type DeliveryMode } from './util.js';
import { buttonsActions, buttonsBlock, buttonsFallbackText, normalizeButtonLabels, normalizeButtons, placeText, type ButtonsActionsBlock, type ContextBlock } from './reply-buttons.js';
import { saveReplyExtras } from './charts-store.js';
import { buildExtras, degradedFileIds, hasLayoutMarkers, extrasFallback, footerBlock, hasExtras, imageExtras, replyBody, responseTimeFooter, slackTsMs, withoutMarkers, type PreparedImage, type ReplyExtra, type ReplyExtras } from './rich-blocks.js';
import { MAX_MESSAGE_BLOCKS, mdDisplay, replyMessage, segmentBlock, streamHold, streamUnits } from './slack-markdown.js';
import { prepareButtonActions } from './button-actions.js';
import { createReplyButtons, detachMessageCards, loadReplyButtons, messageHasLiveCard, postedBefore, reattachMessageCards, setReplyText, setButtonsMessage, type PlaceTarget, toButtonsState, type ReplyButtonsRow } from './reply-buttons-store.js';
import { ActivityTrail, type AdoptedActivity } from './activity-trail.js';
import { forgetOpenActivity, recordOpenActivity } from './activity-registry.js';
import { privateThreadTs, savePrivateReply, sendFilesToDm, shareActions } from './private-reply.js';
import { sql } from '../db/index.js';

/** Coalescing interval for appends once the stream is open. */
const FLUSH_MS = 250;
/** Before the stream is open: open it as soon as this many characters of text are there… */
const FIRST_FLUSH_CHARS = 8;
/** …or after this long, whichever comes first. */
const FIRST_FLUSH_MS = 80;
const MAX_MD = 11_500; // markdown limit: 12k chars cumulative per message / per stream call
/** The reply's arguments open with `"stream": false` (its schema puts it first; a later or nested one is ignored). */
const streamOff = (buf: string) => /^\s*\{\s*"stream"\s*:\s*false\b/.test(buf);

/** Blocks a stream may carry (50 per message, one kept free for the buttons at stopStream). */
const MAX_STREAM_BLOCKS = MAX_MESSAGE_BLOCKS - 1;
/** A later reply in a turn is held back until this many chars arrived, so it can be checked for duplication first. */
/** In a reply result: the reply's text went out but its files didn't (tools.ts then asks the model to correct it). */
export const FILES_NOT_ATTACHED = 'the files were NOT attached';

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
  /**
   * Slack ts of the user message that triggered the turn: every reply then ends with a context block saying how long
   * it took from that message to the reply (`responseTimeFooter`). Unset: no footer.
   */
  triggerTs?: string;
  /**
   * The model that answered, when it was a fallback (e.g. "GPT-6 Luna" after every Claude tier failed): the footer then
   * says so next to the response time. Null/unset: the configured model answered.
   */
  fallbackModel?: () => string | null;
  /** Clock for the response time (tests). */
  now?: () => number;
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
  /**
   * The turn was started by a prompt button with `place` append / replace (reply-buttons.ts): its first reply goes
   * into that button's message (posted whole, not streamed) instead of a new one; if that fails, it's posted as usual.
   */
  placeTarget?: PlaceTarget | null;
  /**
   * Ephemeral mode (`@bot !p …`, private-reply.ts): every reply goes to this user only, posted whole with
   * chat.postEphemeral (never streamed, no plan card or quick-reply buttons), with a "Send to thread" button; files
   * go to their DM.
   */
  privateTo?: string;
}

/** The plan card as one block (a Slack plan block, live or finished). */
export type CardBlock = { type: 'plan'; block_id?: string };

/**
 * Stream errors meaning Slack is no longer streaming this message (e.g. stopped by the user). `stopped_by_user` too:
 * a frozen stream must never be rewritten (there is no native stop button any more, but a stream Slack halted for any
 * reason stays as it is).
 */
/**
 * Open the reply's stream when the reply call begins, before its text exists (ReplyManager.open). Switched off for
 * the process when Slack refuses an empty chat.startStream, or a stream started empty then refuses chunks (its
 * documentation leaves both open): replies then open their stream with the first text, as before.
 */
export const earlyStream = { enabled: true };
/**
 * Codes meaning Slack refuses a stream started without content (not a problem with this channel, e.g. is_archived /
 * not_in_channel, which must not switch early streams off for every channel).
 */
const EMPTY_START_REFUSED = new Set(['no_text', 'invalid_arguments', 'missing_argument', 'invalid_chunks', 'markdown_text_or_chunks_required', 'markdown_text_required']);

export const HALTED_STREAM = /stream|not_in_streaming_state|stopped_by_user/;
const isHalted = (code: string | undefined) => Boolean(code && code !== 'streaming_mode_mismatch' && HALTED_STREAM.test(code));
const STOPPED_RESULT = 'Not delivered: the user pressed stop. Do not retry; call end_turn.';

interface ReplyEntry {
  index: number;
  /** Idempotency key base instead of `reply:<turn>:<index>` (finishText). */
  keyBase?: string;
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
  /**
   * An empty stream opened when the reply call began (open()): its ts, or null if it wasn't opened. The first flush
   * takes it (takeEarly); a reply that doesn't stream into it removes it (discardEarly). Unset once taken / removed.
   */
  early?: Promise<string | null>;
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
  /** Goes into an earlier message (a prompt button's `place`, ReplyTarget.placeTarget) instead of a new one. */
  place?: PlaceTarget;
  /** The text of that message once the reply went into it (the earlier text plus this reply, when appended). */
  placedText?: string;
  /** Carries files: never placed (attaching files to the earlier message could drop the files it already has). */
  noPlace?: boolean;
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

/** A reply message's final layout: [plan card, reply with its extras and buttons (inline at `[[buttons]]`, else last), footer]. */
export function replyLayout(text: string, actions?: ButtonsActionsBlock | ContextBlock, card?: CardBlock | null, extras?: ReplyExtras | null): { text: string; blocks: unknown[] } {
  const footer = footerBlock(extras);
  const maxBlocks = MAX_MESSAGE_BLOCKS - 1 - (card ? 1 : 0) - footer.length;
  // An empty markdown block is invalid: an extras-only reply is their blocks plus a text fallback.
  const body = replyBody(text, extras, { maxBlocks, idPrefix: '', buttons: actions ?? null });
  return { text: extrasFallback(text, extras), blocks: [...(card ? [card] : []), ...body, ...footer] };
}

/** Files one message may carry (Slack). */
const MAX_MESSAGE_FILES = 10;
/** Slack refused the blocks (e.g. an image it can't fetch, a block type it doesn't render here). */
const BLOCKS_ERRORS = new Set(['invalid_blocks', 'invalid_blocks_format']);
/** Wait before retrying a refused layout that has just-uploaded image files (Slack may still be processing them). */
export const imageRetry = { delayMs: 1500 };

/** Extra (image) inputs to finish(): files (access already checked) or URLs, numbered as the model listed them. */
export interface ImageArg {
  n: number;
  file?: OutgoingFile;
  url?: string;
  alt: string;
  title?: string;
}

/** The rich parts of a reply besides text, files and buttons (see rich-blocks.ts). */
export interface ReplyRich {
  charts?: unknown;
  images?: readonly ImageArg[];
  tables?: unknown;
  cards?: unknown;
  fields?: unknown;
  links?: unknown;
  containers?: unknown;
  /** The model's `stream` flag: false = post the reply whole (never streamed), if nothing is shown yet. */
  stream?: boolean;
  /** Ready-made extras added last (e.g. a live preview's claim buttons, src/sandbox/preview/reply-blocks.ts). */
  extraItems?: readonly ReplyExtra[];
}

export class ReplyManager {
  private entries = new Map<string, ReplyEntry>();
  /** Per delivered reply (tool call id): whether its extras went out as blocks (false: Slack refused them, degraded). */
  private extrasAsBlocks = new Map<string, boolean>();
  private nextIndex = 0;
  /** Number of replies successfully delivered this turn. */
  delivered = 0;
  /** Texts of the replies delivered this turn (for duplicate detection). */
  private deliveredTexts: string[] = [];
  /** The last reply message delivered this turn (the plan card attaches to it). */
  lastDelivered: { ts: string; text: string; streamed: boolean; extras?: ReplyExtras } | null = null;
  /** The last layout sent to each reply message (attaching files rewrites the message with it). */
  private layouts = new Map<string, { text: string; blocks: unknown[] }>();
  /** Image files uploaded for image blocks, by Slack file id (re-shared if a degraded reply can't attach them). */
  private imageFiles = new Map<string, OutgoingFile>();
  private readonly trail: ActivityTrail | null;
  /** ReplyTarget.placeTarget was given to a reply already. */
  private placeUsed = false;

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
    // A reply's stream is (being) opened early: the activity message would appear above the reply and stay empty.
    if (this.anyVisible || [...this.entries.values()].some((e) => e.early)) return;
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
    // While the turn's first delivered reply may still go into a button's message, replies are posted whole (Slack
    // can't stream into an existing message). The place is claimed only when a reply is actually delivered (postWhole):
    // a dropped or failed first call leaves it for the retry.
    const mode = this.t.privateTo || (this.t.placeTarget && !this.placeUsed)
      ? Promise.resolve('post' as const)
      : this.t.activeRuns().then(
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

  /**
   * The reply tool call began (its input is still streaming): open its Slack stream now, empty, so chat.startStream's
   * round trip (~365ms in prod) overlaps the model writing the first words; the first flush then appends to it (the
   * first-flush coalescing is unchanged). Only for a reply that would open a fresh stream anyway: stream delivery, no
   * activity message to adopt. Never blocks or throws.
   */
  open(toolCallId: string): void {
    const e = this.start(toolCallId);
    // An earlier reply call that never got to stream (failed input, the model retrying): its empty stream goes, so it
    // doesn't sit above this one or hold back activity cards.
    for (const o of this.entries.values()) if (o !== e && o.early && !o.finished && !o.streamTs) void this.discardEarly(o);
    if (this.t.privateTo || !earlyStream.enabled || e.early || e.streamTs || e.keyBase || e.finished || this.trail?.isOpen) return;
    const early: Promise<string | null> = this.openEarly(e)
      .catch((err) => {
        const code = slackErrorCode(err);
        // Slack refused an empty stream: stop trying for this process.
        if (code && EMPTY_START_REFUSED.has(code)) earlyStream.enabled = false;
        log.warn({ err, code, turnId: this.t.turnId }, 'opening the reply stream early failed; it opens with the first text');
        return null;
      })
      .then((ts) => {
        if (!ts && e.early === early) e.early = undefined; // nothing opened: nothing to take or hold activity for
        return ts;
      });
    e.early = early;
  }

  private async openEarly(e: ReplyEntry): Promise<string | null> {
    if ((await e.mode) !== 'stream') return null;
    if (e.finished || e.dropped || e.failed || e.streamTs || this.trail?.isOpen || (await this.isStopped())) return null;
    const team = await teamId();
    this.t.timing?.mark('early_stream_open_call');
    // No content: the stream's chunks mode is set by the first chunks sent (Slack's SDKs start streams this way too).
    const res = await slackCall<any>(
      'chat.startStream',
      { channel: this.t.channelId, ...threadTsArg(this.t.threadTs), recipient_user_id: this.t.recipientUserId, ...(team ? { recipient_team_id: team } : {}) },
      { idempotencyKey: this.key(e, ':early') },
    );
    if (!res?.ts) return null;
    this.t.timing?.mark('early_stream_open');
    return res.ts;
  }

  /**
   * The early stream for the first chunks (its ts), or null. Claimed synchronously: one caller gets it (no flush
   * appending to a stream a concurrent close deletes); it's no longer the entry's to discard.
   */
  private async takeEarly(e: ReplyEntry): Promise<string | null> {
    const p = e.early;
    if (!p) return null;
    e.early = undefined;
    return p;
  }

  /**
   * The reply won't stream into its early stream (posted whole, dropped, stopped, never executed): stop and delete
   * it, so no empty message is left behind. Never throws.
   */
  private async discardEarly(e: ReplyEntry): Promise<void> {
    const ts = await this.takeEarly(e);
    if (ts) await this.removeEmptyStream(e, ts);
  }

  private async removeEmptyStream(e: ReplyEntry, ts: string): Promise<void> {
    await slackCall('chat.stopStream', { channel: this.t.channelId, ts }, { idempotencyKey: this.key(e, ':early-stop') })
      .then(() => this.t.onSessionReleased?.())
      .catch((err) => log.debug({ err, code: slackErrorCode(err) }, 'stopping an empty early stream failed'));
    await editMessage('chat.delete', { channel: this.t.channelId, ts }).catch((err) => log.warn({ err, code: slackErrorCode(err), index: e.index }, 'deleting an empty early stream failed'));
  }

  /**
   * The first chunks into the early stream: 'ok', or 'fallback' when it can't take them (e.g. Slack ended the idle
   * stream, or refused chunks after an empty start): it is removed (in the background) and the reply opens a stream
   * as usual. 'stopped': the user stopped meanwhile, nothing more is sent.
   */
  private async appendEarly(e: ReplyEntry, ts: string, chunks: unknown[]): Promise<'ok' | 'fallback' | 'stopped'> {
    this.t.timing?.mark('stream_open_call');
    try {
      await slackCall('chat.appendStream', { channel: this.t.channelId, ts, chunks });
    } catch (err) {
      const code = slackErrorCode(err);
      // Refused (not transient, not a stream Slack ended): an empty start doesn't work here, so every reply would pay
      // for it. Stop trying for this process.
      if (code && !RETRYABLE_EDIT.has(code) && !isHalted(code)) earlyStream.enabled = false;
      log.warn({ err, code, turnId: this.t.turnId }, 'the early reply stream cannot take the reply; opening a fresh one');
      void this.removeEmptyStream(e, ts); // nothing visible in it; the fresh stream needn't wait
      if (await this.isStopped()) {
        e.failed = true;
        return 'stopped';
      }
      return 'fallback';
    }
    e.streamTs = ts;
    this.t.timing?.mark('stream_started');
    return 'ok';
  }

  delta(toolCallId: string, d: string) {
    const e = this.start(toolCallId);
    this.t.timing?.mark('first_reply_delta');
    if (this.t.privateTo) return; // posted whole at the end
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
    return `${e.keyBase ?? `reply:${this.t.turnId}:${e.index}`}${suffix}`;
  }

  /**
   * Send what is newly streamable (see slack-markdown streamUnits) as chunks: markdown text as `markdown_text`
   * chunks, finished code blocks / rich paragraphs as `blocks` chunks. `finalText`: the complete reply.
   */
  private async flush(e: ReplyEntry, finalText?: string) {
    if (e.failed || e.stopped || e.halted || e.dropped || e.overflow) return;
    this.t.timing?.mark('first_flush');
    if ((await e.mode) !== 'stream') return;
    if (!e.streamTs && e.rawSent === 0) {
      // Nothing shown yet: a reply that asked not to stream, or whose opening layout would jump once the final layout
      // goes in (it opens with a marker, or a heading then one), is posted whole instead (finish() → postWhole).
      const hold = streamOff(e.buf) ? 'post' : streamHold(finalText ?? extractPartialString(e.buf, 'text')?.value ?? '', finalText !== undefined);
      if (hold === 'wait') return;
      if (hold === 'post') {
        // Its empty early stream goes now (not left up while the rest is written); the activity trail may show meanwhile.
        e.mode = Promise.resolve('post');
        await this.discardEarly(e);
        return;
      }
    }
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
      if (u.kind === 'skip') {
        // A placement marker: its block goes in with the final layout.
        st.unitIdx = i + 1;
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
      // An early stream (open()) takes the first chunks; no activity message opened since (activity() holds off).
      const early = e.streamTs ? null : await this.takeEarly(e);
      const took = early ? await this.appendEarly(e, early, chunks) : null;
      if (took === 'stopped') return;
      if (took === 'ok') {
        Object.assign(e, st);
        e.streamed = base.slice(0, e.rawSent);
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
            ...threadTsArg(this.t.threadTs),
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

  /**
   * Post text the model wrote outside a reply call (front.ts: a plain-text answer) exactly like a reply (same
   * sanitising, delivery, card and events), under its own idempotency key `textreply:<turn>`.
   */
  async finishText(text: string): Promise<string> {
    const id = `textreply:${this.t.turnId}`;
    this.start(id).keyBase = id;
    return this.finish(id, text);
  }

  /** Called from the tool's execute with the complete, validated input. */
  /** Whether the reply of this tool call was delivered with its extras as blocks (not degraded to their text fallbacks). */
  extrasDeliveredAsBlocks(toolCallId: string): boolean {
    return this.extrasAsBlocks.get(toolCallId) === true;
  }

  async finish(toolCallId: string, rawText: string, files?: OutgoingFile[], buttons?: readonly unknown[], chartsRaw?: unknown, rich: ReplyRich = {}): Promise<string> {
    const e = this.start(toolCallId);
    e.finished = true;
    const text = neutralizeBroadcasts(rawText);
    const built = buildExtras({ charts: chartsRaw ?? rich.charts, tables: rich.tables, cards: rich.cards, fields: rich.fields, links: rich.links, containers: rich.containers });
    const extras = built.extras;
    const chartNotes = built.notes;
    if (rich.images?.length) {
      const { images: imgs, failed } = await this.prepareImages(e, rich.images, chartNotes);
      // Image files that couldn't be uploaded for the blocks are attached as files instead (another try).
      if (failed.length) files = [...(files ?? []), ...failed.filter((f) => !files?.some((g) => g.fileId === f.fileId))].slice(0, MAX_MESSAGE_FILES);
      // Images come after charts, before tables and cards.
      const at = extras.items.findIndex((it) => !it.ref.startsWith('chart:'));
      extras.items.splice(at < 0 ? extras.items.length : at, 0, ...imageExtras(imgs));
    }
    if (rich.extraItems?.length) extras.items.push(...rich.extraItems);
    const chartSuffix = () => (chartNotes.length ? ` ${chartNotes.join(' ')}` : '');
    const charts = extras.items;
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    await e.chain.catch(() => {});
    if (rich.stream === false && !e.streamTs && e.rawSent === 0 && (await e.mode) === 'stream') {
      // Asked not to stream and nothing is shown yet: posted whole (postWhole removes the empty early stream).
      e.mode = Promise.resolve('post');
    }
    if (e.halted || (await this.isStopped())) {
      // Close our side quietly (Slack may already have stopped it) and deliver nothing else.
      await this.discardEarly(e);
      if (e.streamTs) await this.stopStream(e).catch((err) => log.debug({ err }, 'stopStream after stop failed'));
      await this.dropActivityCards(e, e.streamed);
      await appendEvent(this.t.threadId, 'reply', 'bot', { turnId: this.t.turnId, index: e.index, stopped: true, streamed: e.streamed });
      return STOPPED_RESULT;
    }
    if (this.t.privateTo) return this.finishPrivate(e, toolCallId, this.t.privateTo, text, extras, chartNotes, files, buttons);
    // Marker lines alone show nothing (their extras may have been dropped).
    const blank = !withoutMarkers(text).trim();
    if (!e.streamTs) {
      // Nothing visible yet: an empty reply has nothing to post (Slack rejects empty messages).
      const reason = blank && !files?.length && !charts.length ? (chartNotes.length ? `Not posted: ${chartNotes.join(' ')}` : EMPTY_RESULT) : null;
      if (reason) {
        e.dropped = reason;
        await this.discardEarly(e);
        await appendEvent(this.t.threadId, 'reply_dropped', 'bot', { turnId: this.t.turnId, index: e.index, reason, text });
        return reason;
      }
      if (blank && !charts.length && files?.length) {
        // Just files: shared into the thread as a message of their own (there is no text to attach them to).
        await this.discardEarly(e);
        await this.trail?.discard().catch((err) => log.warn({ err }, 'discarding the activity message failed'));
        try {
          await uploadFiles({ channelId: this.t.channelId, threadTs: this.t.threadTs, files, idempotencyKey: this.key(e, ':files') });
        } catch (err) {
          log.warn({ err }, 'reply file upload failed');
          e.dropped = 'uploading the files failed';
          await appendEvent(this.t.threadId, 'reply_dropped', 'bot', { turnId: this.t.turnId, index: e.index, reason: e.dropped, filesError: String(err) });
          return 'Not posted: uploading the files failed.';
        }
        this.delivered++;
        this.deliveredTexts.push('');
        await this.t.onDelivered?.({ ts: null, text: '', buttons: false }).catch((err) => log.warn({ err }, 'onDelivered failed'));
        await appendEvent(this.t.threadId, 'reply', 'bot', { turnId: this.t.turnId, index: e.index, mode: 'posted', text: '', files: files.map((f) => (f.fileId ? `${f.fileId} (${f.filename})` : f.filename)) });
        const btnNote = normalizeButtonLabels(buttons).length ? ' Buttons need message text, so they were left out.' : '';
        return `Replied (posted) with the files only.${btnNote}${chartSuffix()}`;
      }
    }
    if (files?.length) e.noPlace = true;
    // Files go up (privately) while the reply is delivered, so attaching them right after leaves no gap for another
    // render of the message (plan card, button press) to be overwritten.
    const filesUpload = files?.length
      ? uploadPrivateFiles(files, this.key(e, ':files-private')).then(
          (up) => ({ up }),
          (err: unknown) => ({ err }),
        )
      : null;
    const mode = await e.mode;
    // Quick-reply buttons: the row id goes into the button values, so it exists before the message does.
    const { labels, responses: parsed, notes: buttonNotes } = normalizeButtons(buttons);
    // Action buttons are checked now (their arguments are fixed): one that can't run becomes a prompt button.
    const { responses, notes: actionNotes } = parsed.some((r) => r?.kind === 'action')
      ? await prepareButtonActions(labels, parsed, { threadId: this.t.threadId, channelId: this.t.channelId, speakerId: this.t.recipientUserId })
      : { responses: parsed, notes: [] };
    chartNotes.push(...buttonNotes, ...actionNotes);
    let btnRow: ReplyButtonsRow | null = null;
    if (labels.length) {
      btnRow = await createReplyButtons({ threadId: this.t.threadId, channelId: this.t.channelId, turnId: this.t.turnId, key: this.key(e), labels, responses, requesterId: this.t.recipientUserId }).catch((err) => {
        log.warn({ err }, 'creating reply buttons failed; replying without them');
        return null;
      });
      // A late retry of this turn after a newer turn retired its buttons: they stay retired (left out).
      if (btnRow?.expiredAt && !btnRow.pressedAt) btnRow = null;
    }
    const actions = btnRow ? buttonsActions(btnRow) : undefined;
    // The response time: from the triggering message to now, when the complete reply goes out (after the stream
    // caught up, images were uploaded and buttons created).
    const triggerMs = this.t.triggerTs ? slackTsMs(this.t.triggerTs) : null;
    if (triggerMs != null) extras.footer = responseTimeFooter((this.t.now ?? Date.now)() - triggerMs, this.t.fallbackModel?.() ?? null);
    /** The message that ended up carrying the buttons (set when they went out with it). */
    let buttonsTs: string | null = null;
    let delivered: 'streamed' | 'posted' = 'posted';
    let last: { ts: string | null; text: string } = { ts: null, text };
    if (mode === 'stream' && !e.failed) {
      try {
        // Nothing streamed yet but an activity message is open: stream into it (same result as posting whole).
        // Likewise into a stream opened early (its first text then goes out with the whole reply).
        if (!e.streamTs && (this.trail?.isOpen || (e.early && (await e.early)))) await this.flush(e, text);
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
              last = { ts: await this.post(e, rest, ':rest', actions, null, extras), text: rest };
              buttonsTs = last.ts;
            } else if (hasExtras(extras) && e.streamTs && (await this.finalLayout(e, e.streamed, actions, null, extras))) {
              if (actions) buttonsTs = e.streamTs;
            }
          } else {
            const footer = footerBlock(extras);
            const tail = [...(extras.items.length ? replyBody('', extras, { maxBlocks: MAX_STREAM_BLOCKS - footer.length, idPrefix: '' }) : []), ...(actions ? [actions] : []), ...footer];
            const tailSent = await this.stopStreamTail(e, tail);
            if (actions && tailSent) buttonsTs = e.streamTs;
            // The final layout keeps the turn's plan card above the reply (the live plan's tasks become the card).
            const card = await this.cardBlock();
            // Dividers and a placed buttons row only exist in the final layout (nothing is streamed for a marker).
            if (card || e.blocksChunks > 0 || e.activityCards > 0 || charts.length || (footer.length && !tailSent) || hasLayoutMarkers(text)) {
              if (await this.finalLayout(e, text, actions, card, extras)) {
                if (actions) buttonsTs = e.streamTs;
                await this.rememberExtras(e.streamTs, extras);
                if (card) await this.attachCard(e.streamTs!, text);
              }
            }
            last = { ts: e.streamTs, text };
          }
        } else {
          // Nothing streamed yet (no deltas, or all of it held back): post whole, same visual result.
          last = { ts: await this.postWhole(e, text, actions, extras), text };
          buttonsTs = last.ts;
        }
      } catch (err) {
        log.warn({ err }, 'stream finish failed');
        if (e.streamTs) {
          delivered = 'streamed';
          ({ last, buttonsTs } = await this.recoverStream(e, text, actions, extras));
        } else {
          last = { ts: await this.postWhole(e, text, actions, extras), text };
          buttonsTs = last.ts;
        }
      }
    } else if (e.streamTs) {
      // Stream opened but failed: close it and complete the message.
      delivered = 'streamed';
      ({ last, buttonsTs } = await this.recoverStream(e, text, actions, extras));
    } else {
      last = { ts: await this.postWhole(e, text, actions, extras), text };
      buttonsTs = last.ts;
    }
    // Safety net: an early stream no path took (each one above takes or removes it) never stays behind empty.
    await this.discardEarly(e);
    // Written into a button's message: that message now carries the earlier text plus this reply (appended).
    if (e.placedText != null && last.ts === e.place?.ts) last = { ts: last.ts, text: e.placedText };
    // Posted as a message of its own: postWhole removed the activity message first; one a tool running alongside
    // opened meanwhile goes too.
    if (delivered === 'posted') await this.trail?.discard().catch((err) => log.warn({ err }, 'discarding the activity message failed'));
    if (last.ts) await this.rememberExtras(last.ts, extras);
    if (btnRow) await this.recordButtons(e, btnRow, buttonsTs && buttonsTs === last.ts ? buttonsTs : null, last, extras);
    this.extrasAsBlocks.set(toolCallId, !extras.degraded);
    this.delivered++;
    if (last.ts) this.lastDelivered = { ts: last.ts, text: last.text, streamed: delivered === 'streamed' && last.ts === e.streamTs, ...(hasExtras(extras) ? { extras } : {}) };
    this.deliveredTexts.push(text);
    // A reply placed into an earlier message: the bot's latest word is now (the press that started the turn), not that
    // message's old ts (the thread's partner / unhandled-message tracking would count everything since it).
    const placedTs = e.placedText != null ? (this.t.triggerTs ?? null) : undefined;
    await this.t.onDelivered?.({ ts: placedTs !== undefined ? placedTs : last.ts, text, buttons: Boolean(btnRow) }).catch((err) => log.warn({ err }, 'onDelivered failed'));
    if (files?.length || degradedFileIds(extras).length) {
      const lastMsg = last;
      // Read when attaching (after the upload): the message's latest layout.
      const layout = () => (lastMsg.ts ? (this.layouts.get(lastMsg.ts) ?? replyLayout(lastMsg.text, buttonsTs === lastMsg.ts ? actions : undefined, null, extras)) : null);
      try {
        const dropped = await this.attachFiles(e, last.ts, layout, files ?? [], filesUpload, degradedFileIds(extras));
        if (dropped) chartNotes.push(`${dropped} file(s) didn't fit (Slack allows 10 per message).`);
      } catch (err) {
        log.warn({ err }, 'reply file upload failed');
        await appendEvent(this.t.threadId, 'reply', 'bot', { turnId: this.t.turnId, index: e.index, mode: delivered, text, filesError: String(err) });
        return `Replied (${delivered}), but ${FILES_NOT_ATTACHED} (${err instanceof FileError ? err.message : 'uploading them failed'}).${chartSuffix()}`;
      }
    }
    await appendEvent(this.t.threadId, 'reply', 'bot', {
      turnId: this.t.turnId,
      index: e.index,
      mode: delivered,
      text,
      files: files?.map((f) => (f.fileId ? `${f.fileId} (${f.filename})` : f.filename)),
      ...(btnRow ? { buttons: btnRow.labels } : {}),
      ...(charts.length ? { extras: charts.map((c) => c.summary) } : {}),
      ...(extras.degraded ? { degraded: true } : {}),
    });
    return `Replied (${delivered})${btnRow ? ` with buttons: ${btnRow.labels.join(' | ')}` : ''}.${chartSuffix()}`;
  }

  /**
   * A private turn's reply (ReplyTarget.privateTo): one ephemeral message with a "Send to thread" button; files go to
   * the user's DM (an ephemeral message can't carry files), quick-reply buttons are left out.
   */
  private async finishPrivate(
    e: ReplyEntry,
    toolCallId: string,
    userId: string,
    text: string,
    extras: ReplyExtras,
    notes: string[],
    files?: OutgoingFile[],
    buttons?: readonly unknown[],
  ): Promise<string> {
    const suffix = () => (notes.length ? ` ${notes.join(' ')}` : '');
    const blank = !withoutMarkers(text).trim();
    if (blank && !files?.length && !extras.items.length) {
      const reason = notes.length ? `Not posted: ${notes.join(' ')}` : EMPTY_RESULT;
      e.dropped = reason;
      await appendEvent(this.t.threadId, 'reply_dropped', 'bot', { turnId: this.t.turnId, index: e.index, reason, text, private: true });
      return reason;
    }
    if (normalizeButtonLabels(buttons).length) notes.push("Quick-reply buttons aren't available in a private answer, so they were left out.");
    let body = text;
    let dmed = 0;
    if (files?.length) {
      try {
        await sendFilesToDm(userId, files, this.key(e, ':private-files'));
        dmed = files.length;
        body = `${blank ? '' : `${text}\n\n`}_${dmed === 1 ? 'The file is' : `The ${dmed} files are`} in your DM with me._`;
      } catch (err) {
        log.warn({ err, code: slackErrorCode(err) }, 'private reply: sending the files to the DM failed');
        notes.push("Sending the files to the speaker's DM failed; tell them.");
      }
    }
    if (!withoutMarkers(body).trim() && !extras.items.length) {
      e.dropped = 'nothing to post';
      return `Not posted: sending the files failed and there was no text.${suffix()}`;
    }
    const triggerMs = this.t.triggerTs ? slackTsMs(this.t.triggerTs) : null;
    if (triggerMs != null) extras.footer = responseTimeFooter((this.t.now ?? Date.now)() - triggerMs, this.t.fallbackModel?.() ?? null);
    // The shared copy is the answer as written (its files go with it), without the DM note.
    const replyId = await savePrivateReply({ threadId: this.t.threadId, userId, turnId: this.t.turnId, text, extras: hasExtras(extras) ? extras : null, files: dmed ? (files ?? []) : [] });
    e.posting = true;
    const threadTs = await privateThreadTs(this.t.threadId);
    try {
      await this.withExtras(extras, async () => {
        const msg = replyLayout(body, shareActions(replyId), null, extras);
        await slackCall('chat.postEphemeral', { channel: this.t.channelId, user: userId, ...threadTsArg(threadTs), text: msg.text, blocks: msg.blocks }, { idempotencyKey: this.key(e, ':private') });
      });
    } catch (err) {
      e.posting = false;
      e.dropped = 'posting failed';
      log.warn({ err, code: slackErrorCode(err) }, 'private reply failed');
      await appendEvent(this.t.threadId, 'reply_dropped', 'bot', { turnId: this.t.turnId, index: e.index, reason: 'post failed', text, private: true });
      throw err;
    }
    // A degraded post (Slack refused the extras): the share button posts the same fallbacks.
    if (extras.degraded) await sql`update ephemeral_replies set extras = ${sql.json(extras as never)} where id = ${replyId}`.catch(() => {});
    this.t.timing?.mark('reply_posted');
    this.extrasAsBlocks.set(toolCallId, !extras.degraded);
    this.delivered++;
    this.deliveredTexts.push(text);
    await appendEvent(this.t.threadId, 'reply', 'bot', {
      turnId: this.t.turnId,
      index: e.index,
      mode: 'private',
      text,
      privateReplyId: replyId,
      ...(dmed ? { files: files!.map((f) => (f.fileId ? `${f.fileId} (${f.filename})` : f.filename)), filesTo: 'dm' } : {}),
      ...(extras.items.length ? { extras: extras.items.map((c) => c.summary) } : {}),
      ...(extras.degraded ? { degraded: true } : {}),
    });
    return `Replied privately (only <@${userId}> sees it${dmed ? '; the files went to their DM' : ''}).${suffix()}`;
  }

  /** Persist extras before a plan card can re-render this message (a re-render rebuilds blocks from the DB). */
  private async rememberExtras(ts: string | null, extras: ReplyExtras): Promise<void> {
    if (!ts || !hasExtras(extras)) return;
    await saveReplyExtras(this.t.channelId, ts, extras).catch((err) => log.warn({ err }, 'saving reply extras failed'));
  }

  /**
   * A Slack call carrying the reply's extras. Slack refusing the blocks → tried once more after a moment when there
   * are just-uploaded image files (they may still be processing), then degraded for good (`extras.degraded`: the
   * markdown fallbacks instead, rich-blocks.ts). Other errors are thrown as they are.
   */
  private async withExtras<T>(extras: ReplyExtras | null | undefined, send: () => Promise<T>): Promise<T> {
    if (!extras?.items.length || extras.degraded) return send();
    try {
      return await send();
    } catch (err) {
      if (!BLOCKS_ERRORS.has(slackErrorCode(err) ?? '')) throw err;
      if (extras.items.some((it) => it.slackFileId)) {
        await new Promise((r) => setTimeout(r, imageRetry.delayMs));
        try {
          return await send();
        } catch (err2) {
          if (!BLOCKS_ERRORS.has(slackErrorCode(err2) ?? '')) throw err2;
        }
      }
      log.warn({ err, code: slackErrorCode(err), extras: extras.items.map((it) => it.ref), turnId: this.t.turnId }, 'Slack refused the reply extras; sending their markdown fallbacks');
      extras.degraded = true;
      try {
        return await send();
      } catch (err3) {
        // Refused without them too: not the extras' fault (e.g. the message can't be edited). Keep them for the next try.
        extras.degraded = false;
        throw err3;
      }
    }
  }

  /** chat.update of a reply message with its layout (remembered for attaching files later). */
  private async updateLayout(ts: string, layout: () => { text: string; blocks: unknown[] }, extras?: ReplyExtras | null): Promise<void> {
    await this.withExtras(extras, async () => {
      const msg = layout();
      await editMessage('chat.update', { channel: this.t.channelId, ts, ...msg });
      this.layouts.set(ts, msg);
    });
  }

  private async post(e: ReplyEntry, text: string, suffix = '', actions?: ButtonsActionsBlock, card?: CardBlock | null, extras?: ReplyExtras | null): Promise<string | null> {
    return this.withExtras(extras, async () => {
      const msg = replyLayout(text, actions, card, extras);
      const res = await slackCall<any>(
        'chat.postMessage',
        { channel: this.t.channelId, ...threadTsArg(this.t.threadTs), text: msg.text, blocks: msg.blocks, unfurl_links: false },
        { idempotencyKey: this.key(e, suffix) },
      );
      this.t.timing?.mark('reply_posted');
      if (res?.ts) this.layouts.set(res.ts, msg);
      return res?.ts ?? null;
    });
  }

  /**
   * Image inputs → images ready for blocks: file images are uploaded to Slack privately (not shared anywhere; the
   * image block shows them). Problems become notes for the model; the rest still goes out.
   */
  private async prepareImages(e: ReplyEntry, images: readonly ImageArg[], notes: string[]): Promise<{ images: PreparedImage[]; failed: OutgoingFile[] }> {
    const out: PreparedImage[] = [];
    const fileArgs = images.filter((i) => i.file);
    let uploaded: { slackFileId: string }[] = [];
    if (fileArgs.length) {
      try {
        uploaded = await uploadPrivateFiles(
          fileArgs.map((i) => i.file!),
          this.key(e, ':images'),
        );
      } catch (err) {
        log.warn({ err }, 'uploading reply images failed');
        notes.push('The image files could not be shown inline, so they were attached as files instead.');
      }
    }
    const failed = uploaded.length ? [] : fileArgs.map((i) => i.file!);
    let k = 0;
    for (const img of images) {
      const base = { n: img.n, alt: img.alt, ...(img.title ? { title: img.title } : {}) };
      if (img.file) {
        const up = uploaded[k++];
        if (up) {
          out.push({ ...base, slackFileId: up.slackFileId });
          this.imageFiles.set(up.slackFileId, img.file);
        }
      } else if (img.url) out.push({ ...base, url: img.url });
    }
    return { images: out, failed };
  }

  /**
   * Put files on the delivered reply message: uploaded privately (`upload`, started before delivery), then attached
   * with chat.update `file_ids` (with its current layout, which chat.update needs). `extraIds`: Slack files already
   * uploaded (a degraded reply's images). At most 10 (Slack); returns how many didn't fit. If attaching fails, the
   * files are shared below the reply instead (a message of their own). Throws if that fails.
   */
  private async attachFiles(
    e: ReplyEntry,
    ts: string | null,
    layoutNow: () => { text: string; blocks: unknown[] } | null,
    files: OutgoingFile[],
    upload: Promise<{ up: Awaited<ReturnType<typeof uploadPrivateFiles>> } | { err: unknown }> | null,
    extraIds: string[],
  ): Promise<number> {
    const total = files.length + extraIds.length;
    const keepExtra = extraIds.slice(0, Math.max(0, MAX_MESSAGE_FILES - files.length));
    if (ts) {
      try {
        const res = upload ? await upload : { up: [] };
        if ('err' in res) throw res.err;
        const layout = layoutNow();
        if (!layout) throw new Error('no layout for the reply message');
        await editMessage('chat.update', { channel: this.t.channelId, ts, ...layout, file_ids: [...res.up.map((u) => u.slackFileId), ...keepExtra] });
        const posts = res.up.flatMap((u) => (u.fileId ? [{ fileId: u.fileId, slackFileId: u.slackFileId, channelId: this.t.channelId, threadId: this.t.threadId }] : []));
        await recordFilePosts(posts).catch((err) => log.warn({ err }, 'recording attached reply files failed'));
        return total - files.length - keepExtra.length;
      } catch (err) {
        log.warn({ err, code: slackErrorCode(err), ts }, 'attaching files to the reply message failed; sharing them below it');
      }
    }
    // A degraded reply's images go along too (re-uploaded: a private Slack file can't be shared any other way).
    const share = [...files, ...keepExtra.flatMap((id) => (this.imageFiles.has(id) ? [this.imageFiles.get(id)!] : []))];
    if (share.length) await uploadFiles({ channelId: this.t.channelId, threadTs: this.t.threadTs, files: share, idempotencyKey: this.key(e, ':files') });
    return total - share.length;
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
  private async postWhole(e: ReplyEntry, text: string, actions?: ButtonsActionsBlock, extras?: ReplyExtras): Promise<string | null> {
    e.posting = true;
    // Posted, not streamed: an early stream goes first (else the reply would land below an empty message).
    await this.discardEarly(e);
    try {
      // The first reply delivered this turn takes the place (if any): into the pressed button's message.
      if (this.t.placeTarget && !this.placeUsed && !e.noPlace) {
        this.placeUsed = true;
        e.place = this.t.placeTarget;
        const placed = await this.placeInto(e, text, actions, extras);
        if (placed) return placed;
      }
      const card = await this.cardBlock();
      const ts = (await this.postIntoActivity(text, actions, card, extras)) ?? (await this.post(e, text, '', actions, card, extras));
      if (extras) await this.rememberExtras(ts, extras);
      if (ts && card) await this.attachCard(ts, text);
      return ts;
    } catch (err) {
      e.posting = false;
      throw err;
    }
  }

  /**
   * The reply written into a prompt button's message (e.place): below its text (append) or instead of it (replace),
   * with this turn's plan card on top (the message's earlier card is detached: one card per message). Null when that
   * message can't take it (gone, not editable): the caller posts a new one.
   */
  private async placeInto(e: ReplyEntry, text: string, actions: ButtonsActionsBlock | undefined, extras?: ReplyExtras): Promise<string | null> {
    const target = e.place!;
    let detached: number[] = [];
    try {
      const row = await loadReplyButtons(target.buttonsId);
      if (!row?.messageTs || row.messageTs !== target.ts) return null;
      // A retried turn whose earlier attempt posted this reply as a new message: keep doing that (no second copy).
      if (await postedBefore(this.key(e))) return null;
      // An earlier turn's plan card still tracks running subagents there: leave that message alone.
      if (await messageHasLiveCard(this.t.channelId, target.ts, this.t.turnId)) return null;
      // The earlier text's chart / image markers would point at this reply's extras: dropped.
      const full = placeText(row.replyText != null ? withoutMarkers(row.replyText) : null, text, target.place);
      const card = await this.cardBlock();
      // Without new buttons the message keeps the press's note (a plan card render would put it back anyway).
      const tail = actions ?? buttonsBlock(toButtonsState(row)) ?? undefined;
      // The earlier card goes first, so a render of it that is due can't write the old layout over this reply.
      detached = await detachMessageCards(this.t.channelId, target.ts, this.t.turnId);
      await this.updateLayout(target.ts, () => replyLayout(full, tail, card, extras), extras);
      this.t.timing?.mark('reply_posted');
      await this.trail?.discard().catch((err) => log.warn({ err }, 'discarding the activity message failed'));
      await setReplyText(row.id, full).catch((err) => log.warn({ err }, 'saving the placed reply text failed'));
      if (card) await this.attachCard(target.ts, full);
      e.placedText = full;
      return target.ts;
    } catch (err) {
      log.info({ code: slackErrorCode(err), turnId: this.t.turnId, ts: target.ts }, 'the pressed button\'s message cannot take the reply; posting a new one');
      if (detached.length) await reattachMessageCards(detached, target.ts).catch((e2) => log.warn({ err: e2 }, 'reattaching the earlier plan card failed'));
      return null;
    }
  }

  /** The reply rewritten into the open activity message (see postWhole); null when there is none or it had to go. */
  private async postIntoActivity(text: string, actions: ButtonsActionsBlock | undefined, card: CardBlock | null, extras?: ReplyExtras): Promise<string | null> {
    if (!this.trail?.isOpen) {
      await this.trail?.discard().catch((err) => log.warn({ err }, 'discarding the activity message failed'));
      return null;
    }
    const a = await this.trail.adopt();
    if (!a) return null;
    if (!(await this.postedSince(a.ts))) {
      try {
        try {
          await slackCall('chat.stopStream', { channel: this.t.channelId, ts: a.ts, ...(a.chunks.length ? { chunks: a.chunks } : {}) }, { idempotencyKey: a.stopKey });
          this.t.onSessionReleased?.();
        } catch (err) {
          // Slack already ended the stream (e.g. idle during a long tool call): the message is still ours and the
          // latest, so the reply is still written into it (no delete + post gap); only a failed update drops it.
          log.info({ code: slackErrorCode(err), turnId: this.t.turnId }, 'stopping the activity message failed (already ended?); updating it anyway');
        }
        await this.updateLayout(a.ts, () => replyLayout(text, actions, card, extras), extras);
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
  private async recoverStream(e: ReplyEntry, text: string, actions?: ButtonsActionsBlock, extras?: ReplyExtras): Promise<{ last: { ts: string | null; text: string }; buttonsTs: string | null }> {
    await this.stopStream(e).catch((err) => log.debug({ err }, 'stopStream after failure failed'));
    try {
      await this.updateLayout(e.streamTs!, () => replyLayout(text, actions, null, extras), extras);
      return { last: { ts: e.streamTs, text }, buttonsTs: actions ? e.streamTs : null };
    } catch (err) {
      log.warn({ err, code: slackErrorCode(err), index: e.index }, 'completing a failed stream via chat.update failed; posting the rest');
    }
    const rest = text.slice(e.rawSent);
    if (!rest.trim() && !extras?.items.length) return { last: { ts: e.streamTs, text: e.streamed }, buttonsTs: null };
    // The update didn't land, so the stream has no extra blocks (stopStream above sent none).
    const ts = await this.post(e, rest, rest.trim() ? ':rest' : ':charts', actions, null, extras);
    return { last: { ts, text: rest }, buttonsTs: actions || extras?.items.length ? ts : null };
  }

  /**
   * After a stream that carried blocks chunks, activity tasks or gets the turn's card: re-render the finished message
   * with the posted layout ([card], prose as markdown, code as rich_text, in order, [buttons]), so it ends up exactly
   * like a posted reply. Returns false (logged) when Slack refused it. Never throws.
   */
  private async finalLayout(e: ReplyEntry, text: string, actions?: ButtonsActionsBlock, card?: CardBlock | null, extras?: ReplyExtras): Promise<boolean> {
    try {
      await this.updateLayout(e.streamTs!, () => replyLayout(text, actions, card, extras), extras);
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
   * Finalise a stream, with charts and/or buttons as `blocks` (chat.stopStream renders them at the bottom of the
   * finalized message). If Slack refuses that, stop it without them (recordButtons then attaches buttons another way).
   * Returns true when that tail went out.
   */
  private async stopStreamTail(e: ReplyEntry, tail: unknown[]): Promise<boolean> {
    if (!tail.length) {
      await this.stopStream(e);
      return false;
    }
    try {
      await this.stopStream(e, undefined, tail);
      return true;
    } catch (err) {
      log.warn({ err, code: slackErrorCode(err), index: e.index }, 'chat.stopStream with blocks failed; stopping without them');
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
  private async recordButtons(e: ReplyEntry, row: ReplyButtonsRow, sentWith: string | null, last: { ts: string | null; text: string }, extras?: ReplyExtras) {
    try {
      if (sentWith) {
        await setButtonsMessage(row.id, sentWith, last.text);
        return;
      }
      const actions = buttonsActions(row);
      if (last.ts) {
        try {
          await this.updateLayout(last.ts, () => replyLayout(last.text, actions, null, extras), extras);
          await setButtonsMessage(row.id, last.ts, last.text);
          return;
        } catch (err) {
          log.warn({ err, code: slackErrorCode(err), ts: last.ts }, 'adding reply buttons via chat.update failed; posting them as a follow-up');
        }
      }
      const res = await slackCall<any>(
        'chat.postMessage',
        { channel: this.t.channelId, ...threadTsArg(this.t.threadTs), text: buttonsFallbackText(toButtonsState(row)), blocks: [actions] },
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
      // finish() threw before taking or removing its early stream: still never left behind empty.
      if (e.finished && !e.streamTs) await this.discardEarly(e);
      if (e.finished) continue;
      e.finished = true;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      e.dropped ??= 'the reply tool call never executed';
      await e.chain.catch(() => {});
      await this.discardEarly(e);
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
      if (e.finished && !e.streamTs) await this.discardEarly(e);
      if (e.finished) continue;
      e.finished = true;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      await e.chain.catch(() => {});
      await this.discardEarly(e);
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
      await this.discardEarly(e); // empty: nothing visible to close
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
