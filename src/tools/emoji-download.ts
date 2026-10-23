/**
 * download_emoji (front + children): the workspace's custom emoji (`emoji.list`, bot token, `emoji:read`, cached in
 * Redis) saved into the file store, so they can be looked at, posted, edited in a sandbox or re-uploaded.
 */
import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../config.js';
import { redis } from '../core/redis.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { registerTool, type ToolContext } from '../core/tools.js';
import { createFile, FileError } from '../files/store.js';
import { formatBytes, sniffMime } from '../files/format.js';
import { log } from '../log.js';
import { BlockedUrlError, safeFetch } from './safe-fetch.js';
import { cleanEmojiName } from './emoji.js';

const LIST_KEY = 'emoji:list';
const MAX_ALIAS_HOPS = 5;
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** Image types a custom emoji can be. */
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The workspace's custom emoji: name → image URL or `alias:<name>`. Cached in Redis (limits.emojiListCacheS). */
export async function customEmojiList(): Promise<Record<string, string>> {
  const cached = await redis.get(LIST_KEY).catch(() => null);
  if (cached) return JSON.parse(cached);
  const res = await slackCall<any>('emoji.list', {}, { maxWaitMs: 10_000 });
  const emoji: Record<string, string> = res.emoji && typeof res.emoji === 'object' ? res.emoji : {};
  await redis.set(LIST_KEY, JSON.stringify(emoji), 'EX', limits.emojiListCacheS).catch(() => {});
  return emoji;
}

/** Drop the cached list (e.g. after an emoji was added, so it is found right away). */
export async function forgetEmojiList(): Promise<void> {
  await redis.del(LIST_KEY).catch(() => {});
}

export type EmojiLookup =
  | { kind: 'custom'; name: string; url: string; aliasOf?: string }
  /** An alias of a standard emoji: there is no workspace image. */
  | { kind: 'standard'; name: string }
  | { kind: 'missing'; name: string };

/** Resolve a name in an emoji.list map, following `alias:` entries (pure). */
export function lookupEmoji(list: Record<string, string>, raw: string): EmojiLookup {
  const name = cleanEmojiName(raw).split('::')[0]!;
  let current = name;
  for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop++) {
    const v = list[current];
    if (v === undefined) return hop === 0 ? { kind: 'missing', name } : { kind: 'standard', name };
    if (!v.startsWith('alias:')) return { kind: 'custom', name, url: v, ...(current !== name ? { aliasOf: current } : {}) };
    current = v.slice('alias:'.length);
  }
  return { kind: 'missing', name };
}

/** Emoji images are on Slack's public CDN; anything else in the list is not fetched. */
export function isEmojiImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'slack-edge.com' || u.hostname.endsWith('.slack-edge.com'));
  } catch {
    return false;
  }
}

export type EmojiFetcher = (url: string, signal?: AbortSignal) => Promise<{ status: number; body: Buffer; truncated: boolean }>;

const defaultFetcher: EmojiFetcher = (url, signal) =>
  safeFetch(url, { maxBytes: limits.fileMaxBytes, timeoutMs: DOWNLOAD_TIMEOUT_MS, maxRedirects: 2, signal });

type DownloadCtx = Pick<ToolContext, 'role' | 'threadId' | 'speakerId' | 'turnId' | 'runId' | 'subagentId' | 'abortSignal'>;

/** Save custom emoji into the file store. One line per name: its file id, or why not. */
export async function downloadEmojis(ctx: DownloadCtx, names: string[], opts: { fetch?: EmojiFetcher } = {}): Promise<string> {
  const wanted = [...new Set(names.map((n) => cleanEmojiName(n).split('::')[0]!).filter(Boolean))];
  if (!wanted.length) return 'Give at least one emoji name.';
  if (wanted.length > limits.emojiDownloadMaxPerCall) return `At most ${limits.emojiDownloadMaxPerCall} emoji per call.`;
  let list: Record<string, string>;
  try {
    list = await customEmojiList();
  } catch (err) {
    log.warn({ err }, 'emoji.list failed');
    return `Couldn't list this workspace's emoji (${slackErrorCode(err) || errMsg(err)}).`;
  }
  const fetcher = opts.fetch ?? defaultFetcher;
  const scope = ctx.runId ? `run:${ctx.runId}` : ctx.turnId ? `turn:${ctx.turnId}` : null;
  const lines: string[] = [];
  let saved = 0;
  for (const raw of wanted) {
    const hit = lookupEmoji(list, raw);
    if (hit.kind === 'missing') {
      lines.push(`:${hit.name}: no custom emoji with that name here (standard emoji can't be downloaded; search_emojis finds custom ones).`);
      continue;
    }
    if (hit.kind === 'standard') {
      lines.push(`:${hit.name}: is an alias of a standard emoji, not a custom image; it can't be downloaded.`);
      continue;
    }
    if (!isEmojiImageUrl(hit.url)) {
      lines.push(`:${hit.name}: its image isn't on Slack's emoji CDN, so it wasn't fetched.`);
      continue;
    }
    try {
      const res = await fetcher(hit.url, ctx.abortSignal);
      if (res.status >= 400) {
        lines.push(`:${hit.name}: download failed (HTTP ${res.status}).`);
        continue;
      }
      if (res.truncated) {
        lines.push(`:${hit.name}: the image is larger than ${formatBytes(limits.fileMaxBytes)}.`);
        continue;
      }
      const mime = sniffMime(res.body);
      const ext = mime ? IMAGE_EXT[mime] : undefined;
      if (!mime || !ext) {
        lines.push(`:${hit.name}: Slack returned something that isn't an image.`);
        continue;
      }
      const f = await createFile({
        threadId: ctx.threadId,
        ownerId: ctx.speakerId,
        name: `${hit.name}.${ext}`,
        content: res.body,
        mime,
        description: `Custom emoji :${hit.name}: from this workspace${hit.aliasOf ? ` (alias of :${hit.aliasOf}:)` : ''}`,
        createdTurnId: ctx.runId ? null : (ctx.turnId ?? null),
        createdRunId: ctx.runId ?? null,
        createdSubagentId: ctx.subagentId ?? null,
        ...(scope ? { idempotencyKey: `${scope}:emoji:${createHash('sha256').update(hit.name).update('\0').update(res.body).digest('hex').slice(0, 32)}` } : {}),
      });
      saved++;
      lines.push(`:${hit.name}: ${f.id} (${f.name}, ${formatBytes(f.size)}${hit.aliasOf ? `, alias of :${hit.aliasOf}:` : ''})`);
    } catch (err) {
      if (err instanceof BlockedUrlError || err instanceof FileError) lines.push(`:${hit.name}: ${err.message}`);
      else {
        log.debug({ err, name: hit.name }, 'emoji download failed');
        lines.push(`:${hit.name}: download failed (${errMsg(err)}).`);
      }
    }
  }
  if (saved) lines.push(ctx.role === 'front' ? 'Post with reply(files: [ids]); look at one with read_file.' : 'Saved files are listed with your result automatically.');
  return lines.join('\n');
}

registerTool({
  name: 'download_emoji',
  roles: ['front', 'child'],
  build: (ctx) =>
    tool({
      description: `Save this workspace's custom emoji images as files (by name, aliases followed) and get their file ids: to look at one (read_file), post it (reply files) or use it in a sandbox. Up to ${limits.emojiDownloadMaxPerCall} per call. Standard Unicode emoji have no image here.`,
      inputSchema: z.object({
        names: z.array(z.string()).min(1).max(limits.emojiDownloadMaxPerCall).describe('Emoji names without colons, e.g. ["partyparrot", "yay"]'),
      }),
      execute: async ({ names }) => downloadEmojis(ctx, names),
    }),
});
