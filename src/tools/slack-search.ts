import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../config.js';
import { registerTool, type ToolContext } from '../core/tools.js';
import { SlackBusyError, slackCall, slackErrorCode, type SlackPriority, type SlackWaitEvent } from '../core/slack.js';
import { redis } from '../core/redis.js';
import { takeLimit } from '../features/guard.js';
import { renderSlackText, tsLabel } from '../context/format.js';
import { getUserNames } from '../context/users.js';
import { isHiddenMessage } from '../pipeline/guidelines.js';
import { log } from '../log.js';
import { channelFromSlack } from './directory/fields.js';
import { deleteChannel, knownPublicChannels, upsertChannels } from './directory/store.js';
import { errMsg, parseSlackPermalink, textWithAttachments, truncateChars, untrusted } from './util.js';

const MAX_RESULTS = 10;
const TEXT_CHARS = 1200;
const CONTEXT_CHARS = 200;
/** Whole tool output (results are dropped from the end, never cut mid-result). */
const MAX_OUTPUT_CHARS = 12_000;
const VISIBILITY_TTL_S = 60 * 60;

/**
 * First filter on a search match's own channel flags. Fails closed: only a `C…` channel that isn't flagged
 * private / IM / MPIM / group passes, and `is_private` must be `false` or absent. Passing is necessary, not
 * sufficient: the channel must also be verified public (`channelVisibility`: the directory or conversations.info), because newer
 * private channels have `C…` ids too and search matches don't always carry `is_private`.
 */
export function isPublicChannelMatch(m: any): boolean {
  const c = m?.channel;
  if (!c || typeof c.id !== 'string' || !c.id.startsWith('C')) return false;
  if (c.is_private !== undefined && c.is_private !== false) return false;
  if (c.is_im || c.is_mpim || c.is_group) return false;
  return true;
}

/** conversations.info verdict: public only when Slack positively says so (not private, not an IM/MPIM/group). */
export function isPublicChannelInfo(ch: any): boolean {
  if (!ch || typeof ch.id !== 'string') return false;
  return ch.is_private === false && !ch.is_im && !ch.is_mpim && !ch.is_group && ch.is_channel !== false;
}

const visibilityKey = (id: string) => `slack:chanvis:${id}`;

/**
 * Rate-limit options for a tool's Slack calls: the limiter queue (subagents are `background`), how long to wait at most
 * (then SlackBusyError), and who to tell about a wait (the subagent's card label, SLACK_WAIT_EXTRA).
 */
export interface SlackWaitOpts {
  priority?: SlackPriority;
  maxWaitMs?: number;
  onWait?: SlackWaitCallback;
}

/**
 * How long a tool's Slack call may wait for the shared rate limiter. Interactive (a front turn someone is waiting on)
 * fails fast; background (subagents, watches) sits out about one search.messages window, so a burst that used up the
 * background share is served as the window refills instead of getting "rate limited".
 */
export function slackMaxWaitMs(priority: SlackPriority, kind: 'search' | 'read' = 'read'): number {
  if (kind === 'search') return priority === 'background' ? limits.slackSearchBackgroundMaxWaitMs : limits.slackSearchMaxWaitMs;
  return priority === 'background' ? limits.slackToolBackgroundMaxWaitMs : limits.slackToolMaxWaitMs;
}

/**
 * SlackWaitOpts for a tool call in `ctx`: priority by role, the subagent runner's wait callback, and the wait cap for
 * that priority (`slackMaxWaitMs`; `cap` picks search vs read caps, or gives one in ms).
 */
export function slackWaitOpts(ctx: Pick<ToolContext, 'role' | 'extras'>, cap: 'search' | 'read' | number = 'read'): SlackWaitOpts {
  const onWait = typeof ctx.extras[SLACK_WAIT_EXTRA] === 'function' ? (ctx.extras[SLACK_WAIT_EXTRA] as SlackWaitCallback) : undefined;
  const priority: SlackPriority = ctx.role === 'child' ? 'background' : 'interactive';
  const maxWaitMs = typeof cap === 'number' ? cap : slackMaxWaitMs(priority, cap);
  return { priority, maxWaitMs, ...(onWait ? { onWait } : {}) };
}

const retrySeconds = (waitMs: number) => Math.max(1, Math.ceil(waitMs / 1000));

/** Model-facing result when a read gave up on the shared rate limiter. */
export function slackBusyText(what: string, waitMs: number): string {
  const s = retrySeconds(waitMs);
  return `Slack is rate limited right now (~${s}s until a slot frees; the limit is shared by everyone using the bot), so ${what} couldn't be read. Work with what you have, or try again in ~${s}s.`;
}

/** The visibility check's verdicts: verified public (with names), and the ids skipped because Slack was busy. */
export interface ChannelVisibility {
  names: Map<string, string>;
  /** Not verified because the shared rate limiter was too busy (treated as not public; not cached). */
  busy: Set<string>;
  /** Longest wait the busy lookups would have needed (ms). */
  busyWaitMs: number;
}

const isPublicVerdict = (v: string) => v === 'public' || v.startsWith('public:');

/**
 * Remember that `id` is not public (e.g. it was just converted to private): the next check drops it without asking
 * the directory or Slack. Overwrites a cached public verdict.
 */
export async function rememberChannelNotPublic(id: string): Promise<void> {
  await redis.set(visibilityKey(id), 'private', 'EX', VISIBILITY_TTL_S);
}

/**
 * Verified public channels among `ids` → their names ('' when unknown). In order:
 * 1. a cached "not public" verdict (Redis, an hour) drops the channel;
 * 2. the workspace directory (`directory_channels`, public channels only, crawled weekly and kept live by channel
 *    events): a row confirmed within `limits.directoryChannelTrustMaxAgeMs` counts as verified, no Slack call;
 * 3. otherwise conversations.info (bot token), cached in Redis for an hour; a public answer is written through to
 *    the directory, a definite "not public" one removes a stale row.
 * Any error or ambiguity means "not public"; failed lookups aren't cached, so they are retried. With
 * `opts.maxWaitMs`, a lookup that would wait longer for the rate limiter is skipped (fail closed) and listed in
 * `busy`, so the caller can say some results were left out.
 */
export async function channelVisibility(ids: string[], opts: SlackWaitOpts = {}): Promise<ChannelVisibility> {
  const out = new Map<string, string>();
  const busy = new Set<string>();
  let busyWaitMs = 0;
  const uniq = [...new Set(ids)];
  // The directory is only ever a positive answer; if it can't be read, everything falls back to conversations.info.
  const known = await knownPublicChannels(uniq, limits.directoryChannelTrustMaxAgeMs).catch((err) => {
    log.warn({ err }, 'directory channel lookup failed; verifying with conversations.info');
    return new Map<string, string>();
  });
  await Promise.all(
    uniq.map(async (id) => {
      try {
        const cached = await redis.get(visibilityKey(id)).catch(() => null);
        // 'public' (older entries) or 'public:<name>'; anything else is private, and wins over the directory.
        if (cached && !isPublicVerdict(cached)) return;
        if (known.has(id)) {
          out.set(id, known.get(id)!);
          return;
        }
        if (cached) {
          out.set(id, cached.slice('public:'.length));
          return;
        }
        let verdict: string;
        let channel: any = null;
        try {
          const res = await slackCall<any>('conversations.info', { channel: id }, { maxWaitMs: opts.maxWaitMs, priority: opts.priority, onWait: opts.onWait });
          const ok = res?.ok !== false && res?.channel?.id === id && isPublicChannelInfo(res.channel);
          verdict = ok ? `public:${typeof res.channel.name === 'string' ? res.channel.name : ''}` : 'private';
          if (ok) channel = res.channel;
        } catch (err) {
          const code = slackErrorCode(err);
          // Invisible to the bot (a private channel it isn't in) is a definite answer; other errors aren't cached.
          if (code !== 'channel_not_found' && code !== 'method_not_supported_for_channel_type') throw err;
          verdict = 'private';
        }
        await redis.set(visibilityKey(id), verdict, 'EX', VISIBILITY_TTL_S);
        await syncDirectoryChannel(id, channel);
        if (verdict.startsWith('public:')) out.set(id, verdict.slice('public:'.length));
      } catch (err) {
        if (err instanceof SlackBusyError) {
          busy.add(id);
          busyWaitMs = Math.max(busyWaitMs, err.waitMs);
          log.info({ channel: id, waitMs: err.waitMs }, 'channel visibility lookup skipped: rate limited; treating it as private');
          return;
        }
        log.warn({ err, channel: id }, 'channel visibility lookup failed; treating it as private');
      }
    }),
  );
  return { names: out, busy, busyWaitMs };
}

/**
 * Write a conversations.info verdict through to the directory: a public channel is upserted as confirmed (touched),
 * anything else (`channel` null: private / not found) removes a row the directory may still have. Never throws.
 */
async function syncDirectoryChannel(id: string, channel: any): Promise<void> {
  const row = channel ? channelFromSlack(channel) : null;
  await (row ? upsertChannels([row], { touch: true }) : deleteChannel(id)).catch((err) => log.warn({ err, channel: id }, 'directory channel write-through failed'));
}

/** Verified public channels among `ids` → their names (see channelVisibility). */
export async function publicChannelNames(ids: string[], opts: SlackWaitOpts = {}): Promise<Map<string, string>> {
  return (await channelVisibility(ids, opts)).names;
}

/** The subset of `ids` that are verified public channels (see publicChannelNames). */
export async function publicChannelIds(ids: string[], opts: SlackWaitOpts = {}): Promise<Set<string>> {
  return new Set((await publicChannelNames(ids, opts)).keys());
}

/**
 * Matches safe to show: verified public channels only, `##` messages dropped (guidelines). Order kept. `skipped`:
 * matches dropped only because their channel couldn't be verified in time (rate limited).
 */
export async function filterPublicMatchesDetailed(matches: any[], opts: SlackWaitOpts = {}): Promise<{ matches: any[]; skipped: number }> {
  const candidates = matches.filter((m) => isPublicChannelMatch(m) && !isHiddenMessage(m.text));
  if (!candidates.length) return { matches: [], skipped: 0 };
  const vis = await channelVisibility(
    candidates.map((m) => m.channel.id),
    opts,
  );
  return {
    matches: candidates.filter((m) => vis.names.has(m.channel.id)),
    skipped: candidates.filter((m) => vis.busy.has(m.channel.id)).length,
  };
}

/** Matches safe to show (see filterPublicMatchesDetailed). */
export async function filterPublicMatches(matches: any[], opts: SlackWaitOpts = {}): Promise<any[]> {
  return (await filterPublicMatchesDetailed(matches, opts)).matches;
}

const CONTEXT_BEFORE = ['previous_2', 'previous'] as const;
const CONTEXT_AFTER = ['next', 'next_2'] as const;

/**
 * Slack's surrounding messages for a match (`previous_2`, `previous`, `next`, `next_2`), in order. They come from the
 * match's own channel; only call this for matches already verified public. `##` messages are dropped, and so is
 * anything that claims a different channel (defensive: fail closed).
 */
export function matchContext(m: any): { before: any[]; after: any[] } {
  const chan = m?.channel?.id;
  const ok = (c: any) => {
    if (!c || typeof c !== 'object' || !c.ts) return false;
    if (isHiddenMessage(c.text)) return false;
    const other = (typeof c.channel === 'string' ? c.channel : c.channel?.id) ?? parseSlackPermalink(c.permalink)?.channel;
    return !other || other === chan;
  };
  return { before: CONTEXT_BEFORE.map((k) => m?.[k]).filter(ok), after: CONTEXT_AFTER.map((k) => m?.[k]).filter(ok) };
}

/** Thread root ts when the match is a thread reply (from the permalink's `thread_ts` or the match itself). */
export function matchThreadTs(m: any): string | undefined {
  const t = parseSlackPermalink(m?.permalink)?.threadTs ?? (typeof m?.thread_ts === 'string' ? m.thread_ts : undefined);
  return t && t !== m?.ts ? t : undefined;
}

const oneLine = (raw: any, names: Map<string, string>, max: number) =>
  truncateChars(renderSlackText(textWithAttachments(raw), names).replace(/\s+/g, ' ').trim(), max);

const whoOf = (m: any, names: Map<string, string>) =>
  m?.user ? `<@${m.user}> ${names.get(m.user) ?? m.username ?? ''}`.trim() : m?.username || 'unknown';

/** User ids a match's rendering needs names for (authors + mentions, incl. context messages). */
export function searchUserIds(matches: any[]): string[] {
  const ids = new Set<string>();
  for (const m of matches) {
    const { before, after } = matchContext(m);
    for (const x of [m, ...before, ...after]) {
      if (x.user) ids.add(x.user);
      for (const mm of textWithAttachments(x).matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(mm[1]!);
    }
  }
  return [...ids];
}

export function formatSearchMatch(m: any, i: number, names: Map<string, string>): string {
  const ch = m.channel?.id ? (m.channel?.name ? `<#${m.channel.id}|${m.channel.name}>` : `<#${m.channel.id}>`) : '#unknown';
  const lines = [`${i + 1}. ${ch} · ${whoOf(m, names)} · ts ${tsLabel(m.ts)}`, `   ${m.permalink ?? ''}`];
  const root = matchThreadTs(m);
  if (root) lines.push(`   ↳ reply in thread ${root} (not a top-level message). Read the thread with read_public_thread before relying on this; the parent says what it's about.`);
  lines.push(`   ${oneLine(m, names, TEXT_CHARS)}`);
  const { before, after } = matchContext(m);
  const ctx = (c: any) => `      [${tsLabel(c.ts)}] ${whoOf(c, names)}: ${oneLine(c, names, CONTEXT_CHARS)}`;
  if (before.length) lines.push('   nearby before:', ...before.map(ctx));
  if (after.length) lines.push('   nearby after:', ...after.map(ctx));
  return lines.join('\n');
}

/** Formatted results, dropping whole results from the end to stay under `maxChars`. */
export function formatSearchMatches(matches: any[], names: Map<string, string>, maxChars = MAX_OUTPUT_CHARS): { text: string; shown: number } {
  const out: string[] = [];
  let len = 0;
  for (const [i, m] of matches.entries()) {
    const s = formatSearchMatch(m, i, names);
    if (out.length && len + s.length + 1 > maxChars) break;
    out.push(s);
    len += s.length + 1;
  }
  const omitted = matches.length - out.length;
  if (omitted > 0) out.push(`[${omitted} more ${omitted === 1 ? 'result' : 'results'} not shown to keep this short; narrow the query]`);
  return { text: out.join('\n'), shown: matches.length - omitted };
}

// ---------- rate limit, cache, budget ----------

/**
 * `ToolContext.extras` key for a callback told about rate-limit waits of this tool's Slack calls (the subagent
 * runner sets it to show "Waiting for Slack's search rate limit" on the card).
 */
export const SLACK_WAIT_EXTRA = 'onSlackWait';
export type SlackWaitCallback = (ev: SlackWaitEvent) => void;

export type SearchSort = 'relevance' | 'recent' | 'oldest';

/**
 * A verified-public match reduced to what the tool shows (and so what the cache stores): channel id/name, author,
 * ts, permalink, thread root, text with attachment bodies folded in, and the nearby messages that pass matchContext's
 * rules (same channel, no `##`). Rendering a slim match gives the same text as the full one.
 */
export function slimMatch(m: any): any {
  const slimMsg = (x: any) => ({
    ts: x.ts,
    text: textWithAttachments(x),
    ...(typeof x.user === 'string' ? { user: x.user } : {}),
    ...(typeof x.username === 'string' ? { username: x.username } : {}),
    ...(typeof x.permalink === 'string' ? { permalink: x.permalink } : {}),
  });
  const { before, after } = matchContext(m);
  const out: any = {
    ...slimMsg(m),
    channel: { id: m.channel.id, ...(typeof m.channel.name === 'string' ? { name: m.channel.name } : {}) },
    ...(typeof m.thread_ts === 'string' ? { thread_ts: m.thread_ts } : {}),
  };
  const [p2, p1] = before.length >= 2 ? before : [undefined, before[0]];
  if (p2) out.previous_2 = slimMsg(p2);
  if (p1) out.previous = slimMsg(p1);
  if (after[0]) out.next = slimMsg(after[0]);
  if (after[1]) out.next_2 = slimMsg(after[1]);
  return out;
}

/** Redis key of a cached search: (query, sort, page). */
export function searchCacheKey(query: string, sort: SearchSort | undefined, page = 1): string {
  return `slack:search:cache:${createHash('sha256').update(JSON.stringify([query.trim(), sort ?? 'relevance', page])).digest('hex').slice(0, 32)}`;
}

/** Identical searches in flight in this process share one Slack call (per priority: a front turn never sits out a subagent's wait). */
const inflight = new Map<string, Promise<{ matches: any[]; skipped: number }>>();

/**
 * Public matches (verified, `##` dropped, slimmed, at most MAX_RESULTS) for a search: from the short-lived Redis cache
 * when an identical search ran in the last `limits.slackSearchCacheTtlS`, else from search.messages (throws
 * SlackBusyError when the shared limiter would make it wait longer than `maxWaitMs`). Cached results are re-checked
 * against the channel-visibility cache before they're returned (fail closed). The conversations.info checks wait at
 * most `maxWaitMs` too: matches in channels that couldn't be verified in time are dropped and counted in `skipped`
 * (such a result isn't cached).
 */
export async function searchPublicMatches(
  query: string,
  sort: SearchSort | undefined,
  opts: { priority: SlackPriority; maxWaitMs: number; onWait?: SlackWaitCallback },
): Promise<{ matches: any[]; cached: boolean; skipped: number }> {
  const key = searchCacheKey(query, sort);
  const hit = await redis.get(key).catch(() => null);
  if (hit) {
    try {
      const parsed = JSON.parse(hit);
      if (Array.isArray(parsed)) return { ...(await filterPublicMatchesDetailed(parsed, opts)), cached: true };
    } catch {}
  }
  const flightKey = `${key}:${opts.priority}`;
  let p = inflight.get(flightKey);
  if (!p) {
    p = (async () => {
      const res = await slackCall<any>(
        'search.messages',
        {
          query,
          count: 30,
          highlight: false,
          sort: sort === 'recent' || sort === 'oldest' ? 'timestamp' : 'score',
          sort_dir: sort === 'oldest' ? 'asc' : 'desc',
        },
        { token: 'user', maxWaitMs: opts.maxWaitMs, priority: opts.priority, onWait: opts.onWait },
      );
      // Only the filtered list is ever kept or described: never `messages.total`/pagination (they count private hits).
      const filtered = await filterPublicMatchesDetailed(res.messages?.matches ?? [], opts);
      const pub = filtered.matches.slice(0, MAX_RESULTS).map(slimMatch);
      // Incomplete (some channels unverified): not cached, so the next identical search can find them.
      if (!filtered.skipped) await redis.set(key, JSON.stringify(pub), 'EX', limits.slackSearchCacheTtlS).catch((err) => log.debug({ err }, 'search cache write failed'));
      return { matches: pub, skipped: filtered.skipped };
    })().finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, p);
  }
  return { ...(await p), cached: false };
}

/** Appended to search results when some matches were left out because their channel couldn't be verified in time. */
export function skippedNote(skipped: number): string | null {
  if (!skipped) return null;
  return `[Note: ${skipped} more ${skipped === 1 ? 'result was' : 'results were'} skipped because Slack's rate limit kept me from checking that ${skipped === 1 ? 'its channel is' : 'their channels are'} public. Searching again in a minute may show ${skipped === 1 ? 'it' : 'them'}.]`;
}

/** Model-facing result when the shared limiter is full (longer than the caller may wait): says when to retry. */
export function searchBusyText(waitMs: number): string {
  const s = retrySeconds(waitMs);
  return `Slack search is rate limited right now (~${s}s until a slot frees; about 20 searches per 30 s, shared by everyone using the bot). Work with the hits you have; open them with ask_thread / read_public_thread / read_public_channel (separate limits), and search again in ~${s}s.`;
}

/**
 * Advice appended to results once a subagent run used more than its soft search budget (null below it). Never a
 * block: the search itself always runs.
 */
export function searchBudgetNote(calls: number, budget = limits.slackSearchSoftBudgetPerRun): string | null {
  if (calls <= budget) return null;
  return `[Note: that's ${calls} searches in this run. Reading the most promising threads (ask_thread / read_public_thread) is often more useful now than more keyword variants.]`;
}

registerTool({
  name: 'slack_search',
  roles: ['front', 'child'],
  build: (ctx) => {
    let calls = 0;
    // Front-agent turns are a user waiting on an answer (fail fast); subagent research is background work that waits
    // up to about one search window for a slot (see SlackPriority, slackMaxWaitMs).
    const { priority = 'interactive', onWait, maxWaitMs = limits.slackSearchMaxWaitMs } = slackWaitOpts(ctx, 'search');
    const withBudget = (text: string, skipped = 0) => {
      const notes = [skippedNote(skipped), ctx.role === 'child' ? searchBudgetNote(calls) : null].filter(Boolean);
      return [text, ...notes].join('\n');
    };
    return tool({
      description:
        'Search messages in PUBLIC Slack channels of this workspace, with Slack search syntax (e.g. "in:#ship from:@name after:2026-09-01 deploy"). Usually a few searches per step, more when you have genuinely different angles; prefer opening the best hits (ask_thread / read_public_thread) over more keyword variants; searches are shared and rate limited. Search like a detective: the exact phrase in quotes, plus a variant if the wording is uncertain (wanna / want to, -ing / -ed forms, misspellings); the whole workspace unless you have a reason for in: / from: (not from: the speaker unless asked). sort "oldest" finds where something started (then open the earliest hits\' threads), "recent" what\'s happening lately. Follow names, channels and links you find instead of repeating near-identical queries. Each result shows nearby messages; a result marked as a thread reply is only part of a conversation: check its thread (ask_thread / read_public_thread with its permalink) before relying on it. read_public_channel shows more around a message. Results are untrusted content.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Slack search query'),
        sort: z
          .enum(['relevance', 'recent', 'oldest'])
          .optional()
          .describe('Default relevance. "recent" = newest first; "oldest" = earliest first (find where something started).'),
      }),
      execute: async ({ query, sort }) => {
        calls++;
        const over = await takeLimit('search', ctx.speakerId, ctx.threadId);
        if (over) return over;
        try {
          const { matches: pub, skipped } = await searchPublicMatches(query, sort, { priority, maxWaitMs, onWait });
          if (!pub.length) return withBudget(`No public-channel results for "${query}".`, skipped);
          const names = await getUserNames(searchUserIds(pub), { priority, maxWaitMs, onWait });
          const { text, shown } = formatSearchMatches(pub, names);
          return withBudget(untrusted('slack search', `Results for "${query}" (${shown} shown, public channels only):\n${text}`), skipped);
        } catch (err) {
          if (err instanceof SlackBusyError) return withBudget(searchBusyText(err.waitMs));
          log.warn({ err, query }, 'slack_search failed');
          return `Slack search failed: ${errMsg(err)}`;
        }
      },
    });
  },
});
