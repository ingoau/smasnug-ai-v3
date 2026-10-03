/**
 * The one Slack client. Every Slack Web API call in the app goes through `slackCall` (or the helpers below):
 * per-method and per-channel rate limits shared across workers via Redis, backoff on 429s, and idempotency keys
 * on side effects. Card-update coalescing lives in the agent's card renderer, which calls through here.
 */
import { WebClient, type WebAPICallResult } from '@slack/web-api';
import { env } from '../config.js';
import { sql } from '../db/index.js';
import { redis } from './redis.js';
import { log } from '../log.js';
import { fakeCall } from './slack-fake.js';

const FAKE = process.env.SLACK_FAKE === '1';

const clients = {
  bot: new WebClient(env.SLACK_BOT_TOKEN, { rejectRateLimitedCalls: true, retryConfig: { retries: 0 } }),
  user: new WebClient(env.SLACK_USER_TOKEN, { rejectRateLimitedCalls: true, retryConfig: { retries: 0 } }),
};

export type TokenKind = keyof typeof clients;

export interface SlackCallOpts {
  token?: TokenKind;
  /** Side effects: a key derived from the triggering event. A repeated key returns the stored result. */
  idempotencyKey?: string;
}

/** Requests per minute, roughly Slack's tiers. Unlisted methods default to tier 3. */
const METHOD_RPM: Record<string, number> = {
  'chat.postMessage': 300,
  'chat.update': 100,
  'chat.postEphemeral': 100,
  'chat.startStream': 100,
  'chat.appendStream': 600,
  'chat.stopStream': 100,
  'reactions.add': 100,
  'assistant.threads.setStatus': 300,
  'agents.sessions.setStatus': 300,
  'search.messages': 20,
  'conversations.replies': 50,
  'conversations.history': 50,
  'users.info': 100,
  'views.publish': 100,
};
/**
 * Posting a new message is ~1/sec per channel in Slack's docs; allow short bursts. Only calls that create a message
 * count: updates, stream appends/stops and reads are limited per method only, so several threads in one DM channel
 * (or a long stream next to a card) don't throttle each other.
 */
const PER_CHANNEL_PER_MIN = 60;
const PER_CHANNEL_METHODS = new Set(['chat.postMessage', 'chat.startStream', 'chat.postEphemeral', 'chat.scheduleMessage']);

async function acquire(key: string, perMin: number) {
  // Sliding window over 60s in a sorted set; wait until a slot frees.
  for (let attempt = 0; attempt < 120; attempt++) {
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    const res = (await redis.eval(
      `redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - 60000)
       local n = redis.call('ZCARD', KEYS[1])
       if n < tonumber(ARGV[2]) then
         redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3]); redis.call('PEXPIRE', KEYS[1], 61000); return 0
       end
       local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
       return tonumber(oldest[2]) + 60000 - tonumber(ARGV[1])`,
      1,
      key,
      now,
      perMin,
      member,
    )) as number;
    if (res === 0) return;
    await sleep(Math.min(Math.max(res, 50), 2000));
  }
  throw new Error(`rate limiter timeout for ${key}`);
}

async function pauseFor(method: string) {
  const until = Number(await redis.get(`slack:429:${method}`));
  if (until && until > Date.now()) await sleep(until - Date.now());
}

export async function slackCall<T extends WebAPICallResult = WebAPICallResult & Record<string, any>>(
  method: string,
  args: Record<string, unknown>,
  opts: SlackCallOpts = {},
): Promise<T> {
  const token = opts.token ?? 'bot';
  if (opts.idempotencyKey) {
    const key = `${method}:${opts.idempotencyKey}`;
    const claimed = await sql`insert into idempotency_keys (key) values (${key}) on conflict do nothing returning key`;
    if (claimed.length === 0) {
      const [row] = await sql<{ result: T | null }[]>`select result from idempotency_keys where key = ${key}`;
      log.debug({ method, key }, 'idempotent skip');
      return (row?.result ?? { ok: true, skipped: true }) as T;
    }
    try {
      const result = await rawCall<T>(method, args, token);
      await sql`update idempotency_keys set result = ${sql.json(result as any)} where key = ${key}`;
      return result;
    } catch (err) {
      await sql`delete from idempotency_keys where key = ${key}`;
      throw err;
    }
  }
  return rawCall<T>(method, args, token);
}

async function rawCall<T>(method: string, args: Record<string, unknown>, token: TokenKind): Promise<T> {
  const channel = typeof args.channel === 'string' ? args.channel : undefined;
  if (FAKE) {
    // Benchmarks can include the shared rate limiter's overhead (SLACK_FAKE_LIMITER=1).
    if (process.env.SLACK_FAKE_LIMITER === '1') await throttle(method, token, channel);
    return (await fakeCall(method, args, token)) as T;
  }
  for (let attempt = 0; ; attempt++) {
    await pauseFor(method);
    await throttle(method, token, channel);
    try {
      return (await clients[token].apiCall(method, args)) as T;
    } catch (err: any) {
      const retryAfter = err?.retryAfter ?? err?.data?.retryAfter;
      if (err?.code === 'slack_webapi_rate_limited_error' && attempt < 5) {
        const ms = (Number(retryAfter) || 1) * 1000;
        await redis.set(`slack:429:${method}`, String(Date.now() + ms), 'PX', ms);
        log.warn({ method, ms }, 'slack 429, backing off');
        continue;
      }
      if (err?.code === 'slack_webapi_request_error' && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

async function throttle(method: string, token: TokenKind, channel: string | undefined) {
  await acquire(`slack:rl:${token}:${method}`, METHOD_RPM[method] ?? 50);
  if (channel && PER_CHANNEL_METHODS.has(method)) {
    await acquire(`slack:rl:chan:${channel}`, PER_CHANNEL_PER_MIN);
  }
}

/** Slack error code from a thrown WebAPI error, e.g. 'invalid_name'. */
export function slackErrorCode(err: unknown): string | undefined {
  return (err as any)?.data?.error;
}

let botIdentity: { userId: string; botId: string } | undefined;
export async function getBotIdentity() {
  if (!botIdentity) {
    const res = await slackCall<any>('auth.test', {});
    botIdentity = { userId: res.user_id, botId: res.bot_id };
  }
  return botIdentity;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
