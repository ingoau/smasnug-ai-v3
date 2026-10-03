/**
 * Reply delivery. Code decides stream vs. post (`chooseDelivery`): streamed replies are forwarded live from the
 * reply tool's streamed arguments (tool input deltas → partial-JSON → chat.appendStream); otherwise the reply is
 * posted whole with a markdown block. Files are uploaded after the message (after stopStream when streaming).
 */
import { appendEvent } from '../core/events.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';
import { uploadFiles, type OutgoingFile } from './files.js';
import { stripCitationMarkers } from '../tools/web-search.js';
import { extractPartialString } from './partial-json.js';
import { chooseDelivery, isNearDuplicate, type DeliveryMode } from './util.js';

const FLUSH_MS = 300;
const MAX_MD = 11_500; // markdown limit is 12k chars per block / stream call
const MAX_TEXT = 3_000; // `text` fallback
/** A later reply in a turn is held back until this many chars arrived, so it can be checked for duplication first. */
const HOLD_CHARS = 160;
export const DUPLICATE_RESULT = "Not posted: nearly identical to a reply you already sent this turn. Don't repeat yourself; end your turn.";

export interface ReplyTarget {
  threadId: string;
  channelId: string;
  threadTs: string;
  turnId: number;
  turnKind: 'user' | 'synthesis';
  /** Recipient for streams outside DMs. */
  recipientUserId: string;
  /** Count of queued/running runs in the thread right now. */
  activeRuns: () => Promise<number>;
  /** True once the user pressed the native stop button: nothing more gets delivered. */
  stopRequested?: () => Promise<boolean>;
  /** Returns a model-facing reason when a new reply must not be delivered (checked when it starts and before posting). */
  blockReply?: () => string | null;
}

/** Stream errors meaning Slack is no longer streaming this message (e.g. the user pressed stop). */
const HALTED_STREAM = /stream|not_in_streaming_state/;
const STOPPED_RESULT = 'Not delivered: the user pressed stop. Do not retry; end your turn.';

interface ReplyEntry {
  index: number;
  mode: Promise<DeliveryMode>;
  buf: string;
  /** Chars of `text` already sent to the stream. */
  sent: number;
  /** The text sent to the stream so far. */
  streamed: string;
  streamTs: string | null;
  stopped: boolean;
  chain: Promise<void>;
  timer: NodeJS.Timeout | null;
  failed: boolean;
  /** Slack stopped the stream itself (native stop button): never post the rest. */
  halted: boolean;
  /** Not delivered (duplicate / blocked): the model-facing reason. */
  dropped: string | null;
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

export function markdownMessage(text: string) {
  const md = text.length > MAX_MD ? `${text.slice(0, MAX_MD)}\n\n_[message truncated]_` : text;
  return { text: text.slice(0, MAX_TEXT), blocks: [{ type: 'markdown', text: md }] };
}

/**
 * The part of a partially streamed reply that is safe to show: citation markers stripped, and a trailing
 * possibly-incomplete marker (`\uE200…`, or a word ending in `c`/`ci`/`cit`/`cite…`) held back until more arrives.
 */
export function streamSafePrefix(partial: string): string {
  const s = stripCitationMarkers(partial);
  const m = s.search(/\s?(\uE200[^\uE201]*|c(i(t(e[\w\uE202]*)?)?)?)$/);
  return m >= 0 ? s.slice(0, m) : s;
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

  constructor(private readonly t: ReplyTarget) {}

  /** True if any reply has started becoming visible (a stream started or a message posted). */
  get anyVisible() {
    return this.delivered > 0 || [...this.entries.values()].some((e) => e.streamTs);
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
    e = { index: this.nextIndex++, mode, buf: '', sent: 0, streamed: '', streamTs: null, stopped: false, chain: Promise.resolve(), timer: null, failed: false, halted: false, dropped: this.t.blockReply?.() ?? null };
    this.entries.set(toolCallId, e);
    return e;
  }

  delta(toolCallId: string, d: string) {
    const e = this.start(toolCallId);
    e.buf += d;
    if (!e.timer) {
      e.timer = setTimeout(() => {
        e.timer = null;
        e.chain = e.chain.then(() => this.flush(e)).catch((err) => this.onStreamError(e, err));
      }, FLUSH_MS);
    }
  }

  private key(e: ReplyEntry, suffix = '') {
    return `reply:${this.t.turnId}:${e.index}${suffix}`;
  }

  /** Send any newly decoded text from the partial arguments to the stream. */
  private async flush(e: ReplyEntry, finalText?: string) {
    if (e.failed || e.stopped || e.halted || e.dropped) return;
    if ((await e.mode) !== 'stream') return;
    const value = finalText ?? streamSafePrefix(extractPartialString(e.buf, 'text')?.value ?? '');
    if (value.length <= e.sent) return;
    if (!e.streamTs && finalText === undefined && this.deliveredTexts.length) {
      // A later reply in this turn: don't start streaming until it can be compared with the earlier ones.
      if (value.length < HOLD_CHARS) return;
      if (this.isDuplicate(value)) {
        e.dropped = DUPLICATE_RESULT;
        return;
      }
    }
    if (e.sent + (value.length - e.sent) > MAX_MD) return; // too long to stream further; finish() handles overflow
    const piece = value.slice(e.sent);
    if (await this.isStopped()) {
      // Native stop: Slack halted (or will halt) the stream; send nothing more.
      e.halted = Boolean(e.streamTs);
      e.failed = true;
      return;
    }
    if (!e.streamTs) {
      // Don't open a stream for leading whitespace only.
      if (!piece.trim()) return;
      const team = await teamId();
      const res = await slackCall<any>(
        'chat.startStream',
        {
          channel: this.t.channelId,
          thread_ts: this.t.threadTs,
          markdown_text: piece,
          recipient_user_id: this.t.recipientUserId,
          ...(team ? { recipient_team_id: team } : {}),
        },
        { idempotencyKey: this.key(e) },
      );
      e.streamTs = res.ts ?? null;
      if (!e.streamTs) throw new Error('chat.startStream returned no ts');
    } else {
      await slackCall('chat.appendStream', { channel: this.t.channelId, ts: e.streamTs, markdown_text: piece });
    }
    e.sent = value.length;
    e.streamed = value;
  }

  private onStreamError(e: ReplyEntry, err: unknown) {
    e.failed = true;
    const code = slackErrorCode(err);
    if (e.streamTs && code && HALTED_STREAM.test(code)) {
      e.halted = true;
      log.info({ code, index: e.index }, 'reply stream halted by Slack (stop button?)');
    } else {
      log.warn({ err, index: e.index }, 'reply stream failed; will fall back to posting');
    }
  }

  private isDuplicate(text: string): boolean {
    return this.deliveredTexts.some((prev) => isNearDuplicate(text, prev));
  }

  private async isStopped(): Promise<boolean> {
    return this.t.stopRequested ? this.t.stopRequested().catch(() => false) : false;
  }

  /** Called from the tool's execute with the complete, validated input. */
  async finish(toolCallId: string, rawText: string, files?: OutgoingFile[]): Promise<string> {
    const e = this.start(toolCallId);
    const text = stripCitationMarkers(rawText);
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    await e.chain.catch(() => {});
    if (e.halted || (await this.isStopped())) {
      // Close our side quietly (Slack may already have stopped it) and deliver nothing else.
      if (e.streamTs) await this.stopStream(e).catch((err) => log.debug({ err }, 'stopStream after stop failed'));
      await appendEvent(this.t.threadId, 'reply', 'bot', { turnId: this.t.turnId, index: e.index, stopped: true, streamed: e.streamed });
      return STOPPED_RESULT;
    }
    if (!e.streamTs) {
      // Nothing visible yet: a blocked or repeated reply is dropped instead of posted.
      const reason = e.dropped ?? this.t.blockReply?.() ?? (this.isDuplicate(text) ? DUPLICATE_RESULT : null);
      if (reason) {
        e.dropped = reason;
        await appendEvent(this.t.threadId, 'reply_dropped', 'bot', { turnId: this.t.turnId, index: e.index, reason, text });
        return reason;
      }
    }
    const mode = await e.mode;
    let delivered: 'streamed' | 'posted' = 'posted';
    let last: { ts: string | null; text: string } = { ts: null, text };
    if (mode === 'stream' && !e.failed && text.length <= MAX_MD) {
      try {
        if (e.streamTs) {
          if (!text.startsWith(e.streamed)) {
            log.warn({ index: e.index }, 'streamed prefix diverged from final reply text');
          }
          await this.flush(e, text);
          await this.stopStream(e);
          delivered = 'streamed';
          last = { ts: e.streamTs, text };
        } else {
          // No deltas arrived (non-streaming provider path): post whole, same visual result.
          last = { ts: await this.post(e, text), text };
        }
      } catch (err) {
        log.warn({ err }, 'stream finish failed');
        if (e.streamTs) {
          await this.stopStream(e).catch(() => {});
          delivered = 'streamed';
          last = { ts: e.streamTs, text: e.streamed };
        } else last = { ts: await this.post(e, text), text };
      }
    } else {
      if (e.streamTs) {
        // Stream opened but can't be completed (too long / failed): close it and post the rest whole.
        await this.stopStream(e).catch(() => {});
        const rest = text.slice(e.sent);
        last = { ts: e.streamTs, text: e.streamed };
        if (rest.trim()) last = { ts: await this.post(e, rest, ':rest'), text: rest };
        delivered = 'streamed';
      } else {
        last = { ts: await this.post(e, text), text };
      }
    }
    this.delivered++;
    if (last.ts) this.lastDelivered = { ts: last.ts, text: last.text, streamed: delivered === 'streamed' && last.ts === e.streamTs };
    this.deliveredTexts.push(text);
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
      files: files?.map((f) => f.filename),
    });
    return `Replied (${delivered}).`;
  }

  private async post(e: ReplyEntry, text: string, suffix = ''): Promise<string | null> {
    const msg = markdownMessage(text);
    const res = await slackCall<any>(
      'chat.postMessage',
      { channel: this.t.channelId, thread_ts: this.t.threadTs, ...msg, unfurl_links: false },
      { idempotencyKey: this.key(e, suffix) },
    );
    return res?.ts ?? null;
  }

  private async stopStream(e: ReplyEntry, extra?: string) {
    if (!e.streamTs || e.stopped) return;
    e.stopped = true;
    await slackCall(
      'chat.stopStream',
      { channel: this.t.channelId, ts: e.streamTs, ...(extra ? { markdown_text: extra } : {}) },
      { idempotencyKey: this.key(e, ':stop') },
    );
  }

  /** On a model/API failure (or stop): close any open stream, with a short note if given. Returns true if one was open. */
  async abortOpenStreams(note?: string): Promise<boolean> {
    let any = false;
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer);
      await e.chain.catch(() => {});
      if (e.halted) {
        any = true; // visible, and Slack already stopped it
        continue;
      }
      if (e.streamTs && !e.stopped) {
        any = true;
        await this.stopStream(e, note ? `\n\n${note}` : undefined).catch((err) => log.warn({ err }, 'stopStream failed'));
      }
    }
    return any;
  }
}
