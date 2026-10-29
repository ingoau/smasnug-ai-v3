/** search_emojis (semoji by meaning, cached emoji.list by name), react (reactions.add) and unreact (reactions.remove) — front agent only. */
import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '../config.js';
import { appendEvent } from '../core/events.js';
import { redis } from '../core/redis.js';
import { getBotIdentity, slackCall, slackErrorCode } from '../core/slack.js';
import { registerTool, type ToolContext } from '../core/tools.js';
import { log } from '../log.js';
import { updateStoredReaction } from '../context/reactions-store.js';
import { EXTRAS, getExtra } from './extras.js';
import { normalizeTs } from './util.js';
import { continueTurnSchema } from '../agent/turn-end.js';
import { customEmojiList } from './emoji-download.js';

const SEMOJI_TIMEOUT_MS = 3000;
const SEMOJI_RESULTS = 8;
const CACHE_TTL_S = 7 * 24 * 3600;
/** Name matches listed per call. */
const NAME_RESULTS = 40;
const STANDARD_HINT = 'or use a common standard emoji name (e.g. thumbsup, eyes, tada, white_check_mark, heart, joy).';
const FALLBACK = `Emoji search is unavailable right now: ${STANDARD_HINT.replace(/^or /, '')}`;

export interface EmojiHit {
  name: string;
  summary: string;
}

/** semoji GET /v1/search?q=&limit=&mode=hybrid → [{ name, summary }]. Throws on failure/timeout. */
export async function semojiSearch(query: string, opts: { baseUrl: string; key?: string; timeoutMs?: number; limit?: number }): Promise<EmojiHit[]> {
  const url = new URL('/v1/search', opts.baseUrl);
  url.searchParams.set('q', query.slice(0, 300));
  url.searchParams.set('limit', String(opts.limit ?? SEMOJI_RESULTS));
  url.searchParams.set('mode', 'hybrid');
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? SEMOJI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`semoji HTTP ${res.status}`);
  const body = (await res.json()) as { results?: { name?: string; shortcode?: string; summary?: string }[] };
  return (body.results ?? [])
    .map((r) => ({ name: (r.name || r.shortcode || '').replace(/:/g, ''), summary: (r.summary ?? '').slice(0, 160) }))
    .filter((r) => r.name);
}

/** semojiSearch with one retry (a cold semoji often misses the first call). Throws the last error. */
export async function semojiSearchRetry(query: string, opts: Parameters<typeof semojiSearch>[1], search: typeof semojiSearch = semojiSearch): Promise<EmojiHit[]> {
  try {
    return await search(query, opts);
  } catch (err) {
    // A 4xx won't get better on a retry.
    if (/semoji HTTP 4\d\d/.test(String((err as Error)?.message))) throw err;
    return await search(query, opts);
  }
}

/**
 * Name patterns in a query (pure): the name mode takes emoji names, `:colons:` optional, `*` as a wildcard
 * ("yay-*", "*-cat", "party*parrot"), several separated by spaces or commas. Lowercased; at most 10.
 */
export function namePatterns(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,]+/)
        .map((p) => p.replace(/^:+|:+$/g, '').trim())
        .filter((p) => p && p !== '*' && /^[a-z0-9_+\-'.*]+$/.test(p)),
    ),
  ].slice(0, 10);
}

/** The query asks for names rather than a meaning (pure): a wildcard or `:name:` form. */
export function looksLikeNameQuery(query: string): boolean {
  return /\*/.test(query) || /(^|\s):[a-z0-9_+\-']+:(\s|,|$)/i.test(query.trim());
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^$()|[\]{}\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

/**
 * Custom emoji names matching the patterns (pure), from an emoji.list map (name → URL or `alias:<name>`): exact names
 * first, then the rest alphabetically, at most `limit`. `total` counts every match.
 */
export function matchEmojiNames(list: Record<string, string>, patterns: string[], limit = NAME_RESULTS): { names: { name: string; aliasOf?: string }[]; total: number } {
  const res = patterns.map(globRegex);
  const exact = new Set(patterns.filter((p) => !p.includes('*')));
  const hits = Object.keys(list)
    .filter((n) => Object.hasOwn(list, n) && typeof list[n] === 'string' && res.some((r) => r.test(n)))
    .sort((a, b) => Number(exact.has(b)) - Number(exact.has(a)) || a.localeCompare(b));
  return {
    names: hits.slice(0, limit).map((name) => (list[name]!.startsWith('alias:') ? { name, aliasOf: list[name]!.slice('alias:'.length) } : { name })),
    total: hits.length,
  };
}

/** The name-mode answer (pure). */
export function formatNameMatches(patterns: string[], m: ReturnType<typeof matchEmojiNames>): string {
  if (!m.total) return `No custom emoji named ${patterns.map((p) => `"${p}"`).join(', ')} in this workspace. Try a wildcard ("${patterns[0]!.replace(/\*/g, '')}*"), a description of what it shows, ${STANDARD_HINT}`;
  const lines = m.names.map((n) => `:${n.name}:${n.aliasOf ? ` (alias of :${n.aliasOf}:)` : ''}`);
  const more = m.total > m.names.length ? `\n…and ${m.total - m.names.length} more; narrow the pattern.` : '';
  return `${m.total} custom emoji match ${patterns.join(', ')}:\n${lines.join('\n')}${more}`;
}

/** Name mode: custom emoji names from the cached emoji.list. */
export async function searchEmojiNames(query: string): Promise<string> {
  const patterns = namePatterns(query);
  if (!patterns.length) return 'Give emoji names or patterns, e.g. "yay-*" or "partyparrot".';
  try {
    return formatNameMatches(patterns, matchEmojiNames(await customEmojiList(), patterns));
  } catch (err) {
    log.warn({ err }, 'emoji.list for name search failed');
    return `Couldn't list this workspace's emoji right now: ${STANDARD_HINT.replace(/^or /, '')}`;
  }
}

/**
 * When the meaning search fails: names containing the query's words, from emoji.list, so one semoji timeout doesn't
 * read as "emoji search is down". '' when that finds nothing either.
 */
async function nameFallback(query: string): Promise<string> {
  const words = namePatterns(query.replace(/\*/g, '')).filter((w) => w.length >= 3);
  if (!words.length) return '';
  try {
    const m = matchEmojiNames(await customEmojiList(), words.map((w) => `*${w}*`), 15);
    if (!m.total) return '';
    return `Meaning search didn't answer in time; custom emoji whose names contain ${words.join(', ')}:\n${formatNameMatches(words, m).split('\n').slice(1).join('\n')}`;
  } catch {
    return '';
  }
}

export async function searchEmojis(query: string, mode: 'meaning' | 'name' | 'auto' = 'auto'): Promise<string> {
  const q = query.trim().toLowerCase();
  if (!q) return 'Give a short description of the emoji you want.';
  if (mode === 'name' || (mode === 'auto' && looksLikeNameQuery(q))) return searchEmojiNames(q);
  if (!env.SEMOJI_URL) return (await nameFallback(q)) || FALLBACK;
  const cacheKey = `semoji:${createHash('sha1').update(q).digest('hex')}`;
  try {
    const cached = await redis.get(cacheKey);
    let hits: EmojiHit[];
    if (cached) hits = JSON.parse(cached);
    else {
      hits = await semojiSearchRetry(q, { baseUrl: env.SEMOJI_URL, key: env.SEMOJI_KEY });
      await redis.set(cacheKey, JSON.stringify(hits), 'EX', CACHE_TTL_S);
    }
    if (!hits.length) return `No emoji found for "${query}". Try other words, mode "name" with a pattern (e.g. "${q.split(/\s+/)[0]}*"), ${STANDARD_HINT}`;
    return hits.map((h) => `:${h.name}: — ${h.summary}`).join('\n');
  } catch (err) {
    log.warn({ err, query }, 'semoji search failed (after a retry)');
    return (
      (await nameFallback(q)) ||
      `Meaning search didn't answer this time (it may work on a retry). Try mode "name" with a pattern (e.g. "${q.split(/\s+/)[0]}*"), ${STANDARD_HINT}`
    );
  }
}

registerTool({
  name: 'search_emojis',
  roles: ['front'],
  build: () =>
    tool({
      description:
        'Find custom emoji in this workspace. By meaning: a description ("cat waving", "ship it"). By name: emoji names or patterns with * ("yay-*", "*-parrot", ":partyparrot:"), to check a name exists or list a family. Returns emoji names to use with react.',
      inputSchema: z.object({
        query: z.string().describe('What the emoji should show or mean, or emoji names / patterns like "yay-*"'),
        mode: z.enum(['meaning', 'name']).optional().describe('"name" to match names/patterns; default: by meaning (a * or :name: switches to names)'),
      }),
      execute: async ({ query, mode }) => searchEmojis(query, mode ?? 'auto'),
    }),
});

/** ':Thumbs Up:' → 'thumbs_up'; skin-tone suffix kept ('wave::skin-tone-3'). */
export function cleanEmojiName(raw: string): string {
  return raw
    .trim()
    .replace(/^:+|:+$/g, '')
    .replace(/::/g, '\u0000')
    .replace(/:/g, '')
    .replace(/\u0000/g, '::')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

export async function react(ctx: ToolContext, emojiRaw: string, messageTs?: string): Promise<string> {
  const name = cleanEmojiName(emojiRaw);
  if (!name) return 'No emoji given.';
  const ts = normalizeTs(messageTs) ?? getExtra(ctx.extras, EXTRAS.defaultReactTs);
  if (!ts) return 'No message to react to (give message_ts).';
  const attempt = async (emoji: string) => {
    const key = `${ctx.threadId}:${ctx.turnId ?? ctx.runId ?? 'na'}:${ts}:${emoji}`;
    await slackCall('reactions.add', { channel: ctx.channelId, timestamp: ts, name: emoji }, { idempotencyKey: key });
    await appendEvent(ctx.threadId, 'reaction', 'bot', { emoji, ts, turnId: ctx.turnId ?? null });
    await syncOwnReaction(ctx.channelId, ts, 'added', emoji);
    return `Reacted :${emoji}: to ${ts}.`;
  };
  try {
    return await attempt(name);
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === 'already_reacted') return `Already reacted :${name}:.`;
    if (code === 'invalid_name' && name !== 'thumbsup') {
      try {
        const out = await attempt('thumbsup');
        return `:${name}: doesn't exist here; ${out}`;
      } catch (err2) {
        if (slackErrorCode(err2) === 'already_reacted') return `:${name}: doesn't exist here; already reacted :thumbsup:.`;
        log.debug({ err: err2 }, 'react fallback failed');
        return 'Reaction skipped.';
      }
    }
    // Skip silently: the model doesn't need to retry a failed reaction.
    log.debug({ err, code, name, ts }, 'react failed');
    return 'Reaction skipped.';
  }
}

/** Mirror the bot's own reaction change into `messages.reactions` (the Slack event would do it too, later). */
export async function syncOwnReaction(channelId: string, ts: string, op: 'added' | 'removed', name: string): Promise<void> {
  try {
    const bot = await getBotIdentity();
    if (bot.userId) await updateStoredReaction({ channelId, ts, op, name, user: bot.userId });
  } catch (err) {
    log.debug({ err }, 'syncOwnReaction failed');
  }
}

export async function unreact(ctx: ToolContext, emojiRaw: string, messageTs?: string): Promise<string> {
  const name = cleanEmojiName(emojiRaw);
  if (!name) return 'No emoji given.';
  const ts = normalizeTs(messageTs) ?? getExtra(ctx.extras, EXTRAS.defaultReactTs);
  if (!ts) return 'No message to remove a reaction from (give message_ts).';
  try {
    const key = `unreact:${ctx.threadId}:${ctx.turnId ?? ctx.runId ?? 'na'}:${ts}:${name}`;
    await slackCall('reactions.remove', { channel: ctx.channelId, timestamp: ts, name }, { idempotencyKey: key });
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === 'no_reaction') return 'No such reaction from you.';
    log.debug({ err, code, name, ts }, 'unreact failed');
    return 'Could not remove the reaction.';
  }
  await appendEvent(ctx.threadId, 'reaction_removed', 'bot', { emoji: name, ts, turnId: ctx.turnId ?? null });
  await syncOwnReaction(ctx.channelId, ts, 'removed', name);
  return `Removed :${name}: from ${ts}.`;
}

registerTool({
  name: 'unreact',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        "Remove one of YOUR OWN reactions that is no longer right (e.g. a placeholder like hourglass once the work is done). Rarely needed. Defaults to the message you are responding to; pass message_ts to target another message.",
      inputSchema: z.object({
        emoji: z.string().describe('Emoji name of your reaction, e.g. "hourglass"'),
        message_ts: z.string().optional().describe('ts of the message; default: the triggering message'),
        continue_turn: continueTurnSchema,
      }),
      execute: async ({ emoji, message_ts }) => unreact(ctx, emoji, message_ts),
    }),
});

registerTool({
  name: 'react',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        'Add an emoji reaction INSTEAD of a reply, when a reaction is the whole response (e.g. to a "thanks"). Never together with a reply; at most one per turn. Ends your turn unless continue_turn is true. Defaults to the message you are responding to; pass message_ts (the bracketed ts from context) to react to another message. Any standard or custom emoji name, without colons.',
      inputSchema: z.object({
        emoji: z.string().describe('Emoji name, e.g. "eyes" or "white_check_mark"'),
        message_ts: z.string().optional().describe('ts of the message to react to; default: the triggering message'),
        continue_turn: continueTurnSchema,
      }),
      execute: async ({ emoji, message_ts }) => react(ctx, emoji, message_ts),
    }),
});
