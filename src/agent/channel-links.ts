/**
 * Channel links in bot replies: Slack only renders a clickable channel for `<#C123>`. The model is told to use that
 * form (context and search results carry `<#C123|name>`); as a safety net, a bare `#name` that matches a public
 * channel is turned into `<#ID>`. Channel names are cached in Redis (shared across workers) and in memory, refreshed
 * in the background so replies never wait for the list.
 */
import { slackCall } from '../core/slack.js';
import { redis } from '../core/redis.js';
import { log } from '../log.js';

const REDIS_KEY = 'channels:public:byname';
const TTL_S = 60 * 60;
const MEMORY_TTL_MS = 10 * 60 * 1000;

let memory: { map: Map<string, string>; at: number } | null = null;
let loading: Promise<void> | null = null;

async function fetchFromSlack(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await slackCall<any>('conversations.list', {
      types: 'public_channel',
      exclude_archived: true,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of res.channels ?? []) if (c?.id && c?.name && !c.is_private) map.set(String(c.name).toLowerCase(), c.id);
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return map;
}

async function refresh(): Promise<void> {
  try {
    let entries = await redis.hgetall(REDIS_KEY);
    if (!Object.keys(entries).length) {
      const map = await fetchFromSlack();
      if (map.size) {
        await redis.multi().del(REDIS_KEY).hset(REDIS_KEY, Object.fromEntries(map)).expire(REDIS_KEY, TTL_S).exec();
      }
      entries = Object.fromEntries(map);
    }
    memory = { map: new Map(Object.entries(entries)), at: Date.now() };
  } catch (err) {
    log.warn({ err }, 'channel name cache refresh failed');
    memory = { map: memory?.map ?? new Map(), at: Date.now() };
  } finally {
    loading = null;
  }
}

/** The cached name → id map (possibly empty on a cold start); kicks off a background refresh when stale. */
export function channelNames(): Map<string, string> {
  if ((!memory || Date.now() - memory.at > MEMORY_TTL_MS) && !loading) loading = refresh();
  return memory?.map ?? new Map();
}

/** Warm the cache (e.g. at worker start); resolves once the first load finished. */
export async function warmChannelNames(): Promise<void> {
  channelNames();
  await loading;
}

const BARE_CHANNEL = /(^|[\s(\[,;:])#([a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?)(?=$|[\s).,!?;:\]'"])/gi;

/** Turn bare `#name` mentions of known public channels into `<#ID>`, leaving code spans/blocks alone. */
export function linkifyChannels(text: string, names: Map<string, string> = channelNames()): string {
  if (!names.size || !text.includes('#')) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(BARE_CHANNEL, (m, pre: string, name: string) => {
      const id = names.get(name.toLowerCase());
      return id ? `${pre}<#${id}>` : m;
    })))
    .join('');
}

/** While streaming, hold back a trailing `#partial-name` until it's complete (so it can still become a link). */
export function channelSafePrefix(partial: string): string {
  const m = partial.search(/(^|[\s(\[,;:])#[a-z0-9._-]*$/i);
  return m >= 0 ? partial.slice(0, m + (/^[\s(\[,;:]/.test(partial[m] ?? '') ? 1 : 0)) : partial;
}
