// OWNER: features module.
import { limits } from '../config.js';
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { getState, type GuardState } from './state.js';
import { isAdmin } from './util.js';

export type EntryCheck = { ok: true } | { ok: false; reason: 'paused' | 'channel_disabled' | 'suspended' | 'rate_limited' };

/** Pure entry decision (order matters: pause, channel, suspension, then rate). */
export function evaluateEntry(opts: {
  state: GuardState;
  userId: string;
  channelId?: string;
  admin: boolean;
}): EntryCheck {
  const { state, userId, channelId, admin } = opts;
  if (state.paused && !admin) return { ok: false, reason: 'paused' };
  if (channelId && state.disabledChannels.has(channelId)) return { ok: false, reason: 'channel_disabled' };
  if (!admin && state.blocks.get(userId)?.suspended) return { ok: false, reason: 'suspended' };
  return { ok: true };
}

/**
 * Checked at every entry point (new turns, button clicks, App Home): global pause, channel disable, suspension,
 * messages/hour. The admin bypasses pause and suspension.
 *
 * `opts.countMessage` (default true) counts this call against the user's messages/hour window; pass false for
 * interactions that should be gated but not counted (button clicks, App Home opens).
 * Pass `channelId` only for conversation entry points: channel disable is about the bot taking part in
 * conversations, and `/smasnug on` must keep working in a disabled channel.
 */
export async function checkEntry(userId: string, channelId?: string, opts: { countMessage?: boolean } = {}): Promise<EntryCheck> {
  const state = await getState();
  const res = evaluateEntry({ state, userId, channelId, admin: isAdmin(userId) });
  if (!res.ok) return res;
  if (opts.countMessage !== false) {
    const wait = await slidingWindow(`limit:msg:${userId}`, limits.userMessagesPerHour, HOUR_MS, true);
    if (wait > 0) return { ok: false, reason: 'rate_limited' };
  }
  return { ok: true };
}

export type LimitKind = 'search' | 'websearch' | 'fetch' | 'send' | 'subagent' | 'semantic_search' | 'canvas_read' | 'canvas_write' | 'dj' | 'sandbox_exec';

const HOUR_MS = 60 * 60 * 1000;

const HOURLY: Record<Exclude<LimitKind, 'subagent'>, { max: number; noun: string }> = {
  search: { max: limits.userSlackSearchesPerHour, noun: 'Slack searches' },
  websearch: { max: limits.userWebSearchesPerHour, noun: 'web searches' },
  fetch: { max: limits.userFetchesPerHour, noun: 'page fetches' },
  send: { max: limits.userSendsPerHour, noun: 'messages sent on their behalf' },
  semantic_search: { max: limits.userSemanticSearchesPerHour, noun: 'semantic Slack searches' },
  canvas_read: { max: limits.userCanvasReadsPerHour, noun: 'canvas reads' },
  canvas_write: { max: limits.userCanvasWritesPerHour, noun: 'canvas writes' },
  dj: { max: limits.userDjCommandsPerHour, noun: 'huddle DJ commands' },
  sandbox_exec: { max: limits.userSandboxExecsPerHour, noun: 'sandbox commands' },
};

/**
 * Per-user / per-thread limits. Returns an error string for the model if over limit, else null (and counts usage).
 * - search (Slack) / websearch / fetch / send: per-user sliding hour window in Redis (shared across workers) + a `usage` row.
 * - send: also refused when the user is send-blocked or suspended.
 * - subagent: concurrent active runs per user and per thread, counted in the DB (call before creating the run).
 */
export async function takeLimit(kind: LimitKind, userId: string, threadId?: string): Promise<string | null> {
  if (kind === 'subagent') return checkSubagentConcurrency(userId, threadId);

  if (kind === 'send') {
    const block = (await getState()).blocks.get(userId);
    if (block?.suspended || block?.sendBlocked) return 'This user is blocked from sending messages through the bot.';
  }
  const { max, noun } = HOURLY[kind];
  const wait = await slidingWindow(`limit:${kind}:${userId}`, max, HOUR_MS, true);
  if (wait > 0) return limitMessage(noun, max, wait);
  await sql`insert into usage (user_id, thread_id, kind) values (${userId}, ${threadId ?? null}, ${kind})`.catch((err) =>
    log.warn({ err }, 'usage insert failed'),
  );
  return null;
}

/** One hourly limit's state for the turn message's low-quota warnings. */
export interface QuotaState {
  kind: Exclude<LimitKind, 'subagent'> | 'subagent';
  noun: string;
  max: number;
  remaining: number;
}

/** Close to the limit: at most 5 % of it left (at least 1). */
export function quotaIsLow(q: Pick<QuotaState, 'max' | 'remaining'>): boolean {
  return q.remaining <= Math.max(1, Math.floor(q.max * 0.05));
}

/** Pure: one line per limit that is close (quotaIsLow), '' when none is. */
export function lowQuotaLines(states: QuotaState[]): string {
  return states
    .filter(quotaIsLow)
    .map((q) =>
      q.kind === 'subagent'
        ? q.remaining <= 0
          ? `Subagents: they already have ${q.max} running (the max); a new spawn will be refused until one finishes.`
          : `Subagents: only ${q.remaining} more can run at once for them (max ${q.max}).`
        : q.remaining <= 0
          ? `${q.noun}: none left this hour (max ${q.max}/hour); calls will be refused.`
          : `${q.noun}: only ${q.remaining} left this hour (max ${q.max}/hour).`,
    )
    .join('\n');
}

/**
 * The user's remaining hourly quotas (never counts) and free subagent slots, for the turn message. One Redis round
 * trip (pipelined ZCOUNTs over the sliding windows) and one query.
 */
export async function userQuotaStates(userId: string): Promise<QuotaState[]> {
  const kinds = Object.keys(HOURLY) as Exclude<LimitKind, 'subagent'>[];
  const since = Date.now() - HOUR_MS;
  const p = redis.pipeline();
  for (const k of kinds) p.zcount(`limit:${k}:${userId}`, since, '+inf');
  const [res, rows] = await Promise.all([
    p.exec(),
    sql<{ active: number }[]>`select count(*)::int as active from runs r join subagents s on s.id = r.subagent_id where s.owner_id = ${userId} and r.status in ('queued', 'running')`,
  ]);
  const out: QuotaState[] = kinds.map((k, i) => {
    const used = Number(res?.[i]?.[1] ?? 0) || 0;
    return { kind: k, noun: HOURLY[k].noun.replace(/^./, (c) => c.toUpperCase()), max: HOURLY[k].max, remaining: Math.max(0, HOURLY[k].max - used) };
  });
  out.push({ kind: 'subagent', noun: 'Subagents', max: limits.userConcurrentSubagents, remaining: Math.max(0, limits.userConcurrentSubagents - (rows[0]?.active ?? 0)) });
  return out;
}

/** Like takeLimit but never counts: used to fail early (e.g. before showing a send confirmation). */
export async function peekLimit(kind: Exclude<LimitKind, 'subagent'>, userId: string): Promise<string | null> {
  if (kind === 'send') {
    const block = (await getState()).blocks.get(userId);
    if (block?.suspended || block?.sendBlocked) return 'This user is blocked from sending messages through the bot.';
  }
  const { max, noun } = HOURLY[kind];
  const wait = await slidingWindow(`limit:${kind}:${userId}`, max, HOUR_MS, false);
  return wait > 0 ? limitMessage(noun, max, wait) : null;
}

export function limitMessage(noun: string, max: number, waitMs: number) {
  const mins = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Limit reached: at most ${max} ${noun} per hour for this user. Try again in about ${mins} min. Tell the user briefly; don't retry.`;
}

async function checkSubagentConcurrency(userId: string, threadId?: string): Promise<string | null> {
  const [row] = await sql<{ userActive: number; threadActive: number }[]>`
    select
      (select count(*)::int from runs r join subagents s on s.id = r.subagent_id
        where s.owner_id = ${userId} and r.status in ('queued', 'running')) as user_active,
      (select count(*)::int from runs where thread_id = ${threadId ?? ''} and status in ('queued', 'running')) as thread_active`;
  return subagentLimitError(row?.userActive ?? 0, row?.threadActive ?? 0);
}

/** Pure: given current active run counts, the model-facing error (or null). */
export function subagentLimitError(userActive: number, threadActive: number): string | null {
  if (userActive >= limits.userConcurrentSubagents)
    return `Limit reached: this user already has ${userActive} subagents running (max ${limits.userConcurrentSubagents}). Wait for one to finish or steer an existing one.`;
  if (threadActive >= limits.threadConcurrentSubagents)
    return `Limit reached: this thread already has ${threadActive} subagents running (max ${limits.threadConcurrentSubagents}). Wait for one to finish or steer an existing one.`;
  return null;
}

/**
 * Sliding window in a Redis sorted set. Returns 0 if under the limit (and records the hit when `take`),
 * else the ms until the oldest hit leaves the window.
 */
export async function slidingWindow(key: string, max: number, windowMs: number, take: boolean): Promise<number> {
  const now = Date.now();
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  return (await redis.eval(
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))
     local n = redis.call('ZCARD', KEYS[1])
     if n < tonumber(ARGV[3]) then
       if ARGV[5] == '1' then
         redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4]); redis.call('PEXPIRE', KEYS[1], ARGV[2])
       end
       return 0
     end
     local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
     return math.max(1, tonumber(oldest[2]) + tonumber(ARGV[2]) - tonumber(ARGV[1]))`,
    1,
    key,
    now,
    windowMs,
    max,
    member,
    take ? '1' : '0',
  )) as number;
}

/** Record model token usage (per user/thread) for limits and cost. */
export async function recordModelUsage(opts: {
  userId?: string;
  threadId?: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Of the input tokens, how many the provider's prompt cache served (when reported). */
  cachedInputTokens?: number;
}): Promise<void> {
  await sql`
    insert into usage (user_id, thread_id, kind, model, input_tokens, output_tokens, cached_input_tokens)
    values (${opts.userId ?? null}, ${opts.threadId ?? null}, 'model', ${opts.model}, ${opts.inputTokens ?? null}, ${opts.outputTokens ?? null}, ${opts.cachedInputTokens ?? null})`.catch(
    (err) => log.warn({ err }, 'usage insert failed'),
  );
}
