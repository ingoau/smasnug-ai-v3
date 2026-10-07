/**
 * SLACK_FAKE=1: no network. Every call is appended to the Redis list `slack:fake:calls` (JSON) and answered with a
 * plausible response, so the whole pipeline can be exercised locally against real models. Any module may add cases.
 */
import { redis } from './redis.js';

let counter = 0;

/**
 * Test/dev hook: handlers run before the built-in cases; the first one returning non-undefined wins. A handler may
 * throw `fakeSlackError('invalid_name')` to simulate a Slack API error. Returns a function that removes the handler.
 */
export type FakeHandler = (method: string, args: Record<string, unknown>, token: string) => any;
const handlers: FakeHandler[] = [];
export function addFakeHandler(h: FakeHandler): () => void {
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** An error shaped like @slack/web-api's platform error (`slackErrorCode(err)` reads `data.error`). */
export function fakeSlackError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), { code: 'slack_webapi_platform_error', data: { ok: false, error: code } });
}
const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++counter).padStart(6, '0')}`;

/**
 * Simulated network latency per call (ms), read per call so a benchmark can set it at runtime. Default 0 (tests);
 * `pnpm bench` uses ~150ms. `SLACK_FAKE_LATENCY_JITTER_MS` adds uniform random jitter on top.
 */
function fakeLatencyMs(): number {
  const base = Number(process.env.SLACK_FAKE_LATENCY_MS ?? 0) || 0;
  const jitter = Number(process.env.SLACK_FAKE_LATENCY_JITTER_MS ?? 0) || 0;
  return Math.max(0, base + (jitter ? Math.random() * jitter : 0));
}

/**
 * Slack's streaming contract (docs.slack.dev chat.startStream/appendStream/stopStream): `markdown_text` and
 * `chunks` never in one call, and a stream keeps the mode it was started with (else streaming_mode_mismatch).
 */
const streamModes = new Map<string, 'text' | 'chunks'>();
function checkStreamMode(method: string, args: Record<string, unknown>) {
  if (method !== 'chat.startStream' && method !== 'chat.appendStream' && method !== 'chat.stopStream') return;
  const hasText = args.markdown_text !== undefined;
  const hasChunks = args.chunks !== undefined;
  if (hasText && hasChunks) throw fakeSlackError('cannot_provide_both_markdown_text_and_chunks');
  if (method === 'chat.startStream') return; // the mode is recorded once the ts is known (below)
  const mode = streamModes.get(String(args.ts));
  if (mode && ((mode === 'chunks' && hasText) || (mode === 'text' && hasChunks))) throw fakeSlackError('streaming_mode_mismatch');
}
function recordStreamMode(args: Record<string, unknown>, ts: string) {
  if (streamModes.size > 10_000) streamModes.clear();
  streamModes.set(ts, args.chunks !== undefined ? 'chunks' : 'text');
}

export async function fakeCall(method: string, args: Record<string, unknown>, token: string): Promise<any> {
  const latency = fakeLatencyMs();
  await redis.rpush('slack:fake:calls', JSON.stringify({ at: Date.now(), method, token, args }));
  if (latency > 0) await new Promise((r) => setTimeout(r, latency));
  checkStreamMode(method, args);
  for (const h of handlers) {
    const res = await h(method, args, token);
    if (res !== undefined) return res;
  }
  switch (method) {
    case 'auth.test':
      return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'TFAKE' };
    case 'chat.startStream': {
      const ts = nextTs();
      recordStreamMode(args, ts);
      return { ok: true, channel: args.channel, ts, message_ts: ts };
    }
    case 'chat.postMessage':
    case 'chat.postEphemeral':
      return { ok: true, channel: args.channel, ts: nextTs(), message_ts: nextTs() };
    case 'chat.update':
    case 'chat.appendStream':
    case 'chat.stopStream':
      return { ok: true, channel: args.channel, ts: args.ts };
    case 'chat.getPermalink':
      return { ok: true, permalink: `https://fake.slack.com/archives/${args.channel}/p${String(args.message_ts).replace('.', '')}` };
    case 'users.info': {
      const id = String(args.user);
      return { ok: true, user: { id, name: id.toLowerCase(), real_name: `User ${id}`, tz: 'Europe/Berlin', is_bot: false, profile: { display_name: `User ${id}`, image_192: 'https://example.com/a.png' } } };
    }
    case 'conversations.replies':
    case 'conversations.history':
      return { ok: true, messages: [], has_more: false };
    case 'conversations.info':
      return { ok: true, channel: { id: args.channel, name: 'fake-channel', is_private: false, creator: 'UADMIN', is_member: true } };
    case 'conversations.list':
      return {
        ok: true,
        channels: [
          { id: 'CGENERAL', name: 'general', is_private: false, is_member: true },
          { id: 'CRANDOM', name: 'random', is_private: false, is_member: false },
        ],
        response_metadata: { next_cursor: '' },
      };
    case 'conversations.members':
      return { ok: true, members: ['UADMIN', 'UBOT'], response_metadata: { next_cursor: '' } };
    case 'conversations.join':
      return { ok: true, channel: { id: args.channel } };
    case 'chat.delete':
      return { ok: true, channel: args.channel, ts: args.ts };
    case 'conversations.open':
      return { ok: true, channel: { id: `D${String(args.users)}` } };
    case 'search.messages':
      return { ok: true, messages: { matches: [], total: 0 } };
    case 'files.getUploadURLExternal':
      return { ok: true, upload_url: 'https://fake.invalid/upload', file_id: `F${++counter}` };
    case 'canvases.create':
      return { ok: true, canvas_id: `FCANVAS${++counter}` };
    case 'canvases.getContent':
      return { ok: true, content: '' };
    default:
      return { ok: true };
  }
}

export async function fakeCalls(): Promise<{ method: string; args: any }[]> {
  return (await redis.lrange('slack:fake:calls', 0, -1)).map((s) => JSON.parse(s));
}
