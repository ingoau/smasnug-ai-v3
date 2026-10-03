/**
 * Reply delivery. Code decides stream vs. post (`chooseDelivery`): streamed replies are forwarded live from the
 * reply tool's streamed arguments (tool input deltas → partial-JSON → chat.appendStream); otherwise the reply is
 * posted whole with a markdown block. Files are uploaded after the message (after stopStream when streaming).
 */
import { appendEvent } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { log } from '../log.js';
import { uploadFiles, type OutgoingFile } from './files.js';
import { extractPartialString } from './partial-json.js';
import { chooseDelivery, type DeliveryMode } from './util.js';

const FLUSH_MS = 300;
const MAX_MD = 11_500; // markdown limit is 12k chars per block / stream call
const MAX_TEXT = 3_000; // `text` fallback

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
}

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

export class ReplyManager {
  private entries = new Map<string, ReplyEntry>();
  private nextIndex = 0;
  /** Number of replies successfully delivered this turn. */
  delivered = 0;

  constructor(private readonly t: ReplyTarget) {}

  /** True if any reply has started becoming visible (a stream started or a message posted). */
  get anyVisible() {
    return this.delivered > 0 || [...this.entries.values()].some((e) => e.streamTs);
  }

  start(toolCallId: string): ReplyEntry {
    let e = this.entries.get(toolCallId);
    if (e) return e;
    const mode = this.t.activeRuns().then(
      (n) => chooseDelivery({ turnKind: this.t.turnKind, runningRuns: n }),
      () => 'post' as const,
    );
    e = { index: this.nextIndex++, mode, buf: '', sent: 0, streamed: '', streamTs: null, stopped: false, chain: Promise.resolve(), timer: null, failed: false };
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
    if (e.failed || e.stopped) return;
    if ((await e.mode) !== 'stream') return;
    const value = finalText ?? extractPartialString(e.buf, 'text')?.value ?? '';
    if (value.length <= e.sent) return;
    if (e.sent + (value.length - e.sent) > MAX_MD) return; // too long to stream further; finish() handles overflow
    const piece = value.slice(e.sent);
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
    log.warn({ err, index: e.index }, 'reply stream failed; will fall back to posting');
    e.failed = true;
  }

  /** Called from the tool's execute with the complete, validated input. */
  async finish(toolCallId: string, text: string, files?: OutgoingFile[]): Promise<string> {
    const e = this.start(toolCallId);
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    await e.chain.catch(() => {});
    const mode = await e.mode;
    let delivered: 'streamed' | 'posted' = 'posted';
    if (mode === 'stream' && !e.failed && text.length <= MAX_MD) {
      try {
        if (e.streamTs) {
          if (!text.startsWith(e.streamed)) {
            log.warn({ index: e.index }, 'streamed prefix diverged from final reply text');
          }
          await this.flush(e, text);
          await this.stopStream(e);
          delivered = 'streamed';
        } else {
          // No deltas arrived (non-streaming provider path): post whole, same visual result.
          await this.post(e, text);
        }
      } catch (err) {
        log.warn({ err }, 'stream finish failed');
        if (e.streamTs) {
          await this.stopStream(e).catch(() => {});
          delivered = 'streamed';
        } else await this.post(e, text);
      }
    } else {
      if (e.streamTs) {
        // Stream opened but can't be completed (too long / failed): close it and post the rest whole.
        await this.stopStream(e).catch(() => {});
        const rest = text.slice(e.sent);
        if (rest.trim()) await this.post(e, rest, ':rest');
        delivered = 'streamed';
      } else {
        await this.post(e, text);
      }
    }
    this.delivered++;
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

  private async post(e: ReplyEntry, text: string, suffix = '') {
    const msg = markdownMessage(text);
    await slackCall(
      'chat.postMessage',
      { channel: this.t.channelId, thread_ts: this.t.threadTs, ...msg, unfurl_links: false },
      { idempotencyKey: this.key(e, suffix) },
    );
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

  /** On a model/API failure: close any open stream with a short error note. Returns true if one was open. */
  async abortOpenStreams(note: string): Promise<boolean> {
    let any = false;
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer);
      await e.chain.catch(() => {});
      if (e.streamTs && !e.stopped) {
        any = true;
        await this.stopStream(e, `\n\n${note}`).catch((err) => log.warn({ err }, 'stopStream failed'));
      }
    }
    return any;
  }
}
