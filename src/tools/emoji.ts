/** search_emojis (semoji) and react (reactions.add) — front agent only. */
import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '../config.js';
import { appendEvent } from '../core/events.js';
import { redis } from '../core/redis.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { registerTool, type ToolContext } from '../core/tools.js';
import { log } from '../log.js';
import { EXTRAS, getExtra } from './extras.js';
import { normalizeTs } from './util.js';

const SEMOJI_TIMEOUT_MS = 1000;
const SEMOJI_RESULTS = 8;
const CACHE_TTL_S = 7 * 24 * 3600;
const FALLBACK = 'Emoji search is unavailable right now — use a common standard emoji name instead (e.g. thumbsup, eyes, tada, white_check_mark, heart, joy).';

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

export async function searchEmojis(query: string): Promise<string> {
  const q = query.trim().toLowerCase();
  if (!q) return 'Give a short description of the emoji you want.';
  if (!env.SEMOJI_URL) return FALLBACK;
  const cacheKey = `semoji:${createHash('sha1').update(q).digest('hex')}`;
  try {
    const cached = await redis.get(cacheKey);
    let hits: EmojiHit[];
    if (cached) hits = JSON.parse(cached);
    else {
      hits = await semojiSearch(q, { baseUrl: env.SEMOJI_URL, key: env.SEMOJI_KEY });
      await redis.set(cacheKey, JSON.stringify(hits), 'EX', CACHE_TTL_S);
    }
    if (!hits.length) return `No emoji found for "${query}". ${FALLBACK}`;
    return hits.map((h) => `:${h.name}: — ${h.summary}`).join('\n');
  } catch (err) {
    log.debug({ err, query }, 'semoji search failed');
    return FALLBACK;
  }
}

registerTool({
  name: 'search_emojis',
  roles: ['front'],
  build: () =>
    tool({
      description: "Find custom emoji in this workspace by meaning (e.g. 'cat waving', 'ship it'). Returns emoji names to use with react.",
      inputSchema: z.object({ query: z.string().describe('What the emoji should show or mean') }),
      execute: async ({ query }) => searchEmojis(query),
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

registerTool({
  name: 'react',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        'Add an emoji reaction INSTEAD of a reply, when a reaction is the whole response (e.g. to a "thanks"). Never together with a reply; at most one per turn. Defaults to the message you are responding to; pass message_ts (the bracketed ts from context) to react to another message. Any standard or custom emoji name, without colons.',
      inputSchema: z.object({
        emoji: z.string().describe('Emoji name, e.g. "eyes" or "white_check_mark"'),
        message_ts: z.string().optional().describe('ts of the message to react to; default: the triggering message'),
      }),
      execute: async ({ emoji, message_ts }) => react(ctx, emoji, message_ts),
    }),
});
