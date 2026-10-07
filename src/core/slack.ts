/**
 * The one Slack client. Every Slack Web API call in the app goes through `slackCall` (or the helpers below):
 * per-method and per-channel rate limits shared across workers via Redis, backoff on 429s, and idempotency keys
 * on side effects. Card-update coalescing lives in the agent's card renderer, which calls through here.
 */
import { LogLevel, WebClient, type Logger, type WebAPICallResult } from '@slack/web-api';
import { env, limits } from '../config.js';
import { sql } from '../db/index.js';
import { redis } from './redis.js';
import { log } from '../log.js';
import { fakeCall } from './slack-fake.js';

const FAKE = process.env.SLACK_FAKE === '1';

/**
 * Response warnings Slack sends on every call of a kind, by design, that are not worth a log line. The app doesn't
 * subscribe to `agent_session_stopped` (no native stop button: users clicked it by accident), so every
 * `agents.sessions.setStatus` / streaming call answers with `missing_agent_session_stopped_event_subscription`.
 * The WebClient logs both forms: the code (`response_metadata.warnings`) and the human-readable `[WARN]` text from
 * `response_metadata.messages` ("Subscribe to the agent_session_stopped event so Slack can send stop requests…"),
 * which doesn't contain the code. Both are matched.
 */
export const QUIET_SLACK_WARNINGS: RegExp[] = [/missing_agent_session_stopped_event_subscription/, /\bagent_session_stopped event\b/i];

/** True if a WebClient log line is one of the expected warnings above. */
export function isQuietSlackWarning(msg: unknown[]): boolean {
  return msg.some((m) => typeof m === 'string' && QUIET_SLACK_WARNINGS.some((w) => w.test(m)));
}

/** The WebClient's own logging (response warnings, deprecations) through pino, minus the expected warnings. */
function webClientLogger(name: string): Logger {
  let level = LogLevel.INFO;
  const line = (msg: unknown[]) => msg.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
  return {
    debug: (...m) => log.debug({ slackClient: name }, line(m)),
    info: (...m) => log.info({ slackClient: name }, line(m)),
    warn: (...m) => (isQuietSlackWarning(m) ? log.debug({ slackClient: name }, line(m)) : log.warn({ slackClient: name }, line(m))),
    error: (...m) => log.error({ slackClient: name }, line(m)),
    setLevel: (l) => void (level = l),
    getLevel: () => level,
    setName: () => {},
  };
}

const clients = {
  bot: new WebClient(env.SLACK_BOT_TOKEN, { rejectRateLimitedCalls: true, retryConfig: { retries: 0 }, logger: webClientLogger('bot') }),
  user: new WebClient(env.SLACK_USER_TOKEN, { rejectRateLimitedCalls: true, retryConfig: { retries: 0 }, logger: webClientLogger('user') }),
};

export type TokenKind = keyof typeof clients;

export interface SlackCallOpts {
  token?: TokenKind;
  /** Side effects: a key derived from the triggering event. A repeated key returns the stored result. */
  idempotencyKey?: string;
  /**
   * Fail fast instead of waiting longer than this (ms) for the shared rate limiter or a 429 backoff: throws
   * SlackBusyError. For optional calls the caller can skip (e.g. a secondary search); default: wait.
   */
  maxWaitMs?: number;
  /**
   * Queue class on the shared limiter (default `interactive`). `background` callers wait behind interactive ones and
   * can't use the method's interactive reserve (METHOD_INTERACTIVE_RESERVE).
   */
  priority?: SlackPriority;
  /** Told when the call has to wait for the limiter or a 429 pause (start and end), e.g. for an activity label. */
  onWait?: (ev: SlackWaitEvent) => void;
}

/** Thrown when a call with `maxWaitMs` would have had to wait longer for a rate limit. */
export class SlackBusyError extends Error {
  readonly code = 'slack_busy';
  /** How long the call would have had to wait (ms, a lower bound). */
  readonly waitMs: number;
  constructor(what: string, waitMs: number) {
    super(`${what} is rate limited (would wait ~${Math.ceil(waitMs / 1000)}s)`);
    this.waitMs = waitMs;
  }
}

/**
 * Slots per window, per method (METHOD_WINDOW_MS; default a 60 s window, so requests per minute, roughly Slack's
 * tiers). Unlisted methods default to tier 3.
 */
const METHOD_RPM: Record<string, number> = {
  'chat.postMessage': 300,
  'chat.update': 100,
  'chat.postEphemeral': 100,
  'chat.startStream': 100,
  'chat.appendStream': 600,
  'chat.stopStream': 100,
  'reactions.add': 100,
  'agents.sessions.setStatus': 300,
  'agents.sessions.rename': 50, // Tier 3 (docs.slack.dev/reference/methods/agents.sessions.rename)
  // ~25 per 30 s (≈50/min) measured on the dev app 2026-10-07 (429 on call 25–26 of a burst, Retry-After 30): 20 per
  // 30-s window (METHOD_WINDOW_MS) keeps bursts at 80 % of that, ≈40/min sustained.
  'search.messages': 20,
  'conversations.replies': 50,
  'conversations.history': 50,
  'users.info': 100,
  'views.publish': 100,
  // Canvases (tiers from docs.slack.dev/reference/methods/canvases.*): create is tier 2, the rest tier 3.
  'canvases.create': 20,
  'canvases.edit': 50,
  'canvases.getContent': 50,
  'canvases.sections.lookup': 50,
  'canvases.access.set': 50,
  'files.info': 100,
};
/**
 * Posting a new message is ~1/sec per channel in Slack's docs; allow short bursts. Only calls that create a message
 * count: updates, stream appends/stops and reads are limited per method only, so several threads in one DM channel
 * (or a long stream next to a card) don't throttle each other.
 */
const PER_CHANNEL_PER_MIN = 60;
const PER_CHANNEL_METHODS = new Set(['chat.postMessage', 'chat.startStream', 'chat.postEphemeral', 'chat.scheduleMessage']);

/**
 * Who a call is for. `interactive` (default): a user is waiting on it in a front-agent turn. `background`: subagent
 * research, watches: queued behind interactive calls and kept out of the per-method interactive reserve.
 */
export type SlackPriority = 'interactive' | 'background';

/** A rate-limit wait seen by `slackCall` (`SlackCallOpts.onWait`): once when it starts, once when it's over. */
export interface SlackWaitEvent {
  method: string;
  /** `rate_limit`: the shared limiter's queue; `429`: a pause after Slack answered 429. */
  reason: 'rate_limit' | '429';
  /** Expected wait when it started (a lower bound: callers queued ahead may take slots first). */
  estimateMs: number;
  /** Time actually waited (0 in the start event). */
  waitedMs: number;
  done: boolean;
}

/** Window length per method (ms) where Slack's limit is about bursts, not a minute; others use DEFAULT_WINDOW_MS. */
const METHOD_WINDOW_MS: Record<string, number> = {
  'search.messages': 30_000,
};
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Slots per window only interactive calls may take: background calls stop at `perMin - reserve`, so a user's quick
 * question isn't stuck behind a research job's searches. search.messages is the one that matters (one user token).
 */
const METHOD_INTERACTIVE_RESERVE: Record<string, number> = {
  'search.messages': limits.slackSearchInteractiveReserve,
};

/** A method's shared limit: slots per window, the window, and the interactive reserve. */
export function methodLimit(method: string): { slots: number; windowMs: number; reserve: number } {
  return { slots: METHOD_RPM[method] ?? 50, windowMs: METHOD_WINDOW_MS[method] ?? DEFAULT_WINDOW_MS, reserve: METHOD_INTERACTIVE_RESERVE[method] ?? 0 };
}

/** Waits longer than this are logged (info) with their key. */
const LOG_WAIT_MS = 1000;
/** A waiter re-checks the queue at least this often (which also refreshes its ticket's heartbeat). */
const MAX_POLL_MS = 5000;
/** A queued ticket not refreshed for this long belongs to a dead process: dropped so it doesn't hold up the queue. */
const STALE_TICKET_MS = 20_000;
/** Without a deadline, give up after this long in the queue. */
const MAX_TOTAL_WAIT_MS = 5 * 60_000;

/**
 * One limiter step, atomic. Sliding window of granted calls in a sorted set (KEYS[1], as before). Waiting callers
 * hold FIFO tickets, one queue per priority (KEYS[2] interactive, KEYS[3] background; score = arrival number from
 * KEYS[5]) with heartbeats in KEYS[4]. A ticket is granted when the callers ahead of it (its own queue, plus the
 * whole interactive queue for a background ticket) still leave it a free slot under its cap (perMin; perMin - reserve
 * for background). Otherwise it gets the ms until the window entry whose expiry frees its slot (a lower bound); with more callers
 * ahead than one window holds, the slot comes from a later window: whole windows are added (each frees `cap` slots).
 * Returns {waitMs (0 = granted), callers ahead}.
 */
const ACQUIRE_LUA = `
local now = tonumber(ARGV[1]); local perMin = tonumber(ARGV[2]); local reserve = tonumber(ARGV[3])
local ticket = ARGV[4]; local cls = ARGV[5]; local staleMs = tonumber(ARGV[6]); local windowMs = tonumber(ARGV[7])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)
local stale = redis.call('ZRANGEBYSCORE', KEYS[4], 0, now - staleMs)
for _, t in ipairs(stale) do
  redis.call('ZREM', KEYS[2], t); redis.call('ZREM', KEYS[3], t); redis.call('ZREM', KEYS[4], t)
end
local q = KEYS[2]
if cls == 'b' then q = KEYS[3] end
if not redis.call('ZSCORE', q, ticket) then
  redis.call('ZADD', q, redis.call('INCR', KEYS[5]), ticket)
end
redis.call('ZADD', KEYS[4], now, ticket)
local n = redis.call('ZCARD', KEYS[1])
local ahead = redis.call('ZRANK', q, ticket)
local cap = perMin
if cls == 'b' then
  cap = perMin - reserve
  ahead = ahead + redis.call('ZCARD', KEYS[2])
end
if ahead < cap - n then
  redis.call('ZADD', KEYS[1], now, now .. ':' .. ticket)
  redis.call('PEXPIRE', KEYS[1], windowMs + 1000)
  redis.call('ZREM', q, ticket); redis.call('ZREM', KEYS[4], ticket)
  return {0, ahead}
end
for i = 2, 5 do redis.call('PEXPIRE', KEYS[i], windowMs + staleMs * 2) end
local idx = n - cap + ahead
local rounds = 0
while idx >= n do idx = idx - cap; rounds = rounds + 1 end
local base = 0
if idx >= 0 then
  local e = redis.call('ZRANGE', KEYS[1], idx, idx, 'WITHSCORES')
  if e[2] then base = tonumber(e[2]) + windowMs - now end
end
return {math.max(base + rounds * windowMs, 1), ahead}
`;

export interface AcquireOpts {
  perMin: number;
  /** Slots of `perMin` only interactive callers may take (default 0). */
  reserve?: number;
  priority?: SlackPriority;
  /** Epoch ms: throw SlackBusyError instead of waiting past it (checked against the expected wait: fails fast). */
  deadline?: number;
  /** Called once when the caller has to wait, with the expected ms (a lower bound). */
  onWait?: (estimateMs: number) => void;
  /** Window length: 60 s in production, shorter in tests. */
  windowMs?: number;
}

/**
 * Take a slot of a shared per-key rate limit, waiting in FIFO order (interactive callers before background ones)
 * until one frees. Returns the ms waited. Waits over ~1 s are logged with the key.
 */
export async function acquireRateSlot(key: string, opts: AcquireOpts): Promise<number> {
  const windowMs = opts.windowMs ?? 60_000;
  const reserve = Math.max(0, Math.min(opts.reserve ?? 0, opts.perMin - 1));
  const priority = opts.priority ?? 'interactive';
  const deadline = opts.deadline ?? Infinity;
  const ticket = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  const keys = [key, `${key}:qi`, `${key}:qb`, `${key}:seen`, `${key}:seq`];
  const started = Date.now();
  let queued = false;
  let notified = false;
  try {
    for (;;) {
      const [waitMs, ahead] = (await redis.eval(
        ACQUIRE_LUA,
        keys.length,
        ...keys,
        Date.now(),
        opts.perMin,
        reserve,
        ticket,
        priority === 'background' ? 'b' : 'i',
        STALE_TICKET_MS,
        windowMs,
      )) as [number, number];
      if (waitMs === 0) {
        queued = false;
        const waited = Date.now() - started;
        if (waited > LOG_WAIT_MS) log.info({ key, waitMs: waited, priority }, 'slack rate limiter wait');
        return waited;
      }
      queued = true;
      if (Date.now() + waitMs > deadline) {
        log.info({ key, waitMs, ahead, priority }, 'slack rate limiter busy, failing fast');
        throw new SlackBusyError(key, waitMs);
      }
      if (Date.now() - started > MAX_TOTAL_WAIT_MS) throw new Error(`rate limiter timeout for ${key}`);
      if (!notified) {
        notified = true;
        try {
          opts.onWait?.(waitMs);
        } catch {}
      }
      // Sleep until the slot should free, re-checking at least every MAX_POLL_MS; never past the deadline.
      await sleep(Math.max(5, Math.min(waitMs + 5, MAX_POLL_MS, deadline - Date.now())));
    }
  } finally {
    // Leaving early (busy, error): give up the place in the queue right away.
    if (queued) await redis.multi().zrem(keys[1]!, ticket).zrem(keys[2]!, ticket).zrem(keys[3]!, ticket).exec().catch(() => {});
  }
}

/**
 * Redis key of a 429 pause. Scoped by token kind like the limiter keys (Slack's limits are per token: a 429 on the
 * user token's conversations.replies must not pause the bot token's reads). The kind, never the token, is in the key.
 */
export const pauseKey = (token: TokenKind, method: string) => `slack:429:${token}:${method}`;

async function pauseFor(token: TokenKind, method: string, deadline: number, wait: WaitReporter) {
  const until = Number(await redis.get(pauseKey(token, method)));
  if (until && until > deadline) throw new SlackBusyError(method, until - Date.now());
  if (until && until > Date.now()) {
    const ms = until - Date.now();
    const started = Date.now();
    wait.start('429', ms);
    await sleep(ms);
    wait.end('429', ms, Date.now() - started);
  }
}

/** Sends SlackWaitEvents to `SlackCallOpts.onWait` (never throws into the call). */
interface WaitReporter {
  start(reason: SlackWaitEvent['reason'], estimateMs: number): void;
  end(reason: SlackWaitEvent['reason'], estimateMs: number, waitedMs: number): void;
}

function waitReporter(method: string, onWait: SlackCallOpts['onWait']): WaitReporter {
  const emit = (ev: SlackWaitEvent) => {
    try {
      onWait?.(ev);
    } catch (err) {
      log.debug({ err, method }, 'onWait callback failed');
    }
  };
  return {
    start: (reason, estimateMs) => emit({ method, reason, estimateMs, waitedMs: 0, done: false }),
    end: (reason, estimateMs, waitedMs) => emit({ method, reason, estimateMs, waitedMs, done: true }),
  };
}

/** Thrown instead of posting into a thread whose root message was deleted (Slack would post it top-level). */
export class ThreadGoneError extends Error {
  readonly code = 'thread_root_deleted';
  constructor(channel: string, threadTs: string) {
    super(`thread ${channel}:${threadTs} no longer exists (root message deleted)`);
  }
}

const threadGoneKey = (channel: string, threadTs: string) => `thread:gone:${channel}:${threadTs}`;
const POSTING_METHODS = new Set(['chat.postMessage', 'chat.startStream', 'chat.postEphemeral', 'files.completeUploadExternal']);

/** Remember that a thread's root was deleted, so nothing gets posted into it (30 days, like other thread data). */
export async function markThreadGone(channel: string, threadTs: string): Promise<void> {
  await redis.set(threadGoneKey(channel, threadTs), '1', 'EX', 30 * 24 * 60 * 60);
}

/** True if the thread's root was deleted (markThreadGone): posting into it would throw ThreadGoneError. */
export async function isThreadGone(channel: string, threadTs: string): Promise<boolean> {
  return (await redis.exists(threadGoneKey(channel, threadTs))) > 0;
}

async function assertThreadExists(method: string, args: Record<string, unknown>): Promise<void> {
  if (!POSTING_METHODS.has(method)) return;
  const channel = (args.channel ?? args.channel_id) as string | undefined;
  const threadTs = args.thread_ts as string | undefined;
  if (!channel || !threadTs) return;
  if (await redis.exists(threadGoneKey(channel, threadTs))) throw new ThreadGoneError(channel, threadTs);
}

export async function slackCall<T extends WebAPICallResult = WebAPICallResult & Record<string, any>>(
  method: string,
  args: Record<string, unknown>,
  opts: SlackCallOpts = {},
): Promise<T> {
  try {
    return await slackCallInner<T>(method, args, opts);
  } catch (err: any) {
    const channel = (args.channel ?? args.channel_id) as string | undefined;
    if (typeof channel === 'string' && err?.data?.error === READ_ONLY_ERROR) {
      await markChannelReadOnly(channel).catch(() => {});
      log.info({ method, channel }, 'channel is read-only for the bot; no turns start there for a day');
    }
    throw err;
  }
}

async function slackCallInner<T>(method: string, args: Record<string, unknown>, opts: SlackCallOpts): Promise<T> {
  const token = opts.token ?? 'bot';
  await assertThreadExists(method, args);
  if (opts.idempotencyKey) {
    const key = `${method}:${opts.idempotencyKey}`;
    const claimed = await sql`insert into idempotency_keys (key) values (${key}) on conflict do nothing returning key`;
    if (claimed.length === 0) {
      const [row] = await sql<{ result: T | null }[]>`select result from idempotency_keys where key = ${key}`;
      log.debug({ method, key }, 'idempotent skip');
      return (row?.result ?? { ok: true, skipped: true }) as T;
    }
    try {
      const result = await rawCall<T>(method, args, token, opts);
      await sql`update idempotency_keys set result = ${sql.json(result as any)} where key = ${key}`;
      return result;
    } catch (err) {
      await sql`delete from idempotency_keys where key = ${key}`;
      throw err;
    }
  }
  return rawCall<T>(method, args, token, opts);
}

async function rawCall<T>(method: string, args: Record<string, unknown>, token: TokenKind, opts: SlackCallOpts): Promise<T> {
  const channel = typeof args.channel === 'string' ? args.channel : undefined;
  const deadline = opts.maxWaitMs === undefined ? Infinity : Date.now() + opts.maxWaitMs;
  // Benchmarks and tests can run the fake through the shared rate limiter and 429 handling (SLACK_FAKE_LIMITER=1).
  if (FAKE && process.env.SLACK_FAKE_LIMITER !== '1') return (await fakeCall(method, args, token)) as T;
  const wait = waitReporter(method, opts.onWait);
  for (let attempt = 0; ; attempt++) {
    await pauseFor(token, method, deadline, wait);
    await throttle(method, token, channel, { deadline, priority: opts.priority, wait });
    try {
      return (FAKE ? await fakeCall(method, args, token) : await clients[token].apiCall(method, args)) as T;
    } catch (err: any) {
      const retryAfter = err?.retryAfter ?? err?.data?.retryAfter;
      if (err?.code === 'slack_webapi_rate_limited_error' && attempt < 5) {
        const ms = (Number(retryAfter) || 1) * 1000;
        await redis.set(pauseKey(token, method), String(Date.now() + ms), 'PX', ms);
        log.warn({ method, token, ms }, 'slack 429, backing off');
        if (Date.now() + ms > deadline) throw new SlackBusyError(method, ms);
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

/**
 * Channels where posting failed with `restricted_action_read_only_channel` (e.g. the bot's read-only DM with
 * Slackbot, an announcement-only channel): remembered for a day so intake stops starting turns there.
 */
export const READ_ONLY_ERROR = 'restricted_action_read_only_channel';
const readOnlyKey = (channel: string) => `slack:readonly:${channel}`;
const READ_ONLY_TTL_S = 24 * 60 * 60;

export async function markChannelReadOnly(channel: string): Promise<void> {
  await redis.set(readOnlyKey(channel), '1', 'EX', READ_ONLY_TTL_S);
}

/** True if a Slack call recently found the channel read-only for the bot (markChannelReadOnly). */
export async function isChannelReadOnly(channel: string): Promise<boolean> {
  return (await redis.exists(readOnlyKey(channel))) > 0;
}

/** Limiter key of a method on a token kind (the kind, never the token, is in the key). */
export const rateLimitKey = (token: TokenKind, method: string) => `slack:rl:${token}:${method}`;

async function throttle(
  method: string,
  token: TokenKind,
  channel: string | undefined,
  o: { deadline: number; priority?: SlackPriority; wait: WaitReporter },
) {
  const take = async (key: string, perMin: number, reserve: number, windowMs = DEFAULT_WINDOW_MS) => {
    let estimate = 0;
    const waited = await acquireRateSlot(key, {
      perMin,
      reserve,
      windowMs,
      priority: o.priority,
      deadline: o.deadline,
      onWait: (ms) => {
        estimate = ms;
        o.wait.start('rate_limit', ms);
      },
    });
    if (estimate) o.wait.end('rate_limit', estimate, waited);
  };
  const m = methodLimit(method);
  await take(rateLimitKey(token, method), m.slots, m.reserve, m.windowMs);
  if (channel && PER_CHANNEL_METHODS.has(method)) await take(`slack:rl:chan:${channel}`, PER_CHANNEL_PER_MIN, 0);
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
