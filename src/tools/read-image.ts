/**
 * read_image(id): resolves `img_N` ONLY via `thread_images` for ctx.threadId — so a subagent can only read images
 * that appeared in its thread's context, never arbitrary Slack files.
 *
 * Download: `url_private` is fetched with the bot token in an Authorization header. This is a FILE DOWNLOAD from
 * files.slack.com, not a Web API call, so it deliberately bypasses `slackCall` (no API rate-limit tier applies).
 * The token is only ever sent to https://files.slack.com (dropped on any cross-origin redirect), and the request
 * goes through safeFetch (SSRF filtering, size/time caps). Under SLACK_FAKE any public http(s) URL is fetched
 * without auth, so fixtures can point at public test images.
 *
 * Output: by default the image is returned as a tool-result image part (toModelOutput) — verified live that
 * GPT-6 Luna via OpenRouter reads images in tool results. If the agent sets `extras.queueUserImage` (see
 * extras.ts), the image is handed to it instead and the tool returns "image loaded" text.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '../config.js';
import { registerTool } from '../core/tools.js';
import { getThreadImage, type ThreadImage } from '../context/images.js';
import { log } from '../log.js';
import { EXTRAS, getExtra } from './extras.js';
import { processImage } from './image-process.js';
import { safeFetch } from './safe-fetch.js';
import { errMsg } from './util.js';

const FAKE = process.env.SLACK_FAKE === '1';
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const SLACK_FILES_ORIGIN = 'https://files.slack.com';
export const IMAGE_CACHE_DIR = path.resolve(process.env.IMAGE_CACHE_DIR ?? '.cache/images');

export interface LoadedImage {
  id: string;
  name: string | null;
  mediaType: 'image/jpeg' | 'image/png';
  /** base64 */
  data: string;
  width: number;
  height: number;
}

export type ImageDownloader = (img: ThreadImage) => Promise<Buffer>;

export const downloadSlackFile: ImageDownloader = async (img) => {
  if (!img.urlPrivate) throw new Error('image has no download URL');
  const url = new URL(img.urlPrivate);
  if (!FAKE && url.origin !== SLACK_FILES_ORIGIN) throw new Error(`refusing to download from ${url.origin}`);
  const headers: Record<string, string> = { accept: 'image/*,*/*;q=0.5' };
  if (!FAKE && env.SLACK_BOT_TOKEN) headers.authorization = `Bearer ${env.SLACK_BOT_TOKEN}`;
  const res = await safeFetch(url.toString(), { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 20_000, headers, authOrigin: SLACK_FILES_ORIGIN });
  if (res.status >= 400) throw new Error(`download failed: HTTP ${res.status}`);
  if (res.truncated) throw new Error('image is larger than 25MB');
  // Slack serves an HTML login page (200) when auth is missing/invalid.
  if (res.contentType.includes('text/html')) throw new Error('download returned HTML (missing files:read scope or bad token?)');
  return res.body;
};

const cachePaths = (fileId: string) => {
  const safe = fileId.replace(/[^A-Za-z0-9_-]/g, '_');
  return { bin: path.join(IMAGE_CACHE_DIR, `${safe}.bin`), meta: path.join(IMAGE_CACHE_DIR, `${safe}.json`) };
};

async function readCache(fileId: string) {
  const p = cachePaths(fileId);
  try {
    const meta = JSON.parse(await readFile(p.meta, 'utf8')) as { mediaType: LoadedImage['mediaType']; width: number; height: number };
    return { ...meta, data: await readFile(p.bin) };
  } catch {
    return null;
  }
}

async function writeCache(fileId: string, img: { mediaType: string; width: number; height: number; data: Buffer }) {
  const p = cachePaths(fileId);
  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  await writeFile(p.bin, img.data);
  await writeFile(p.meta, JSON.stringify({ mediaType: img.mediaType, width: img.width, height: img.height }));
}

/** Resolve + download + process (+ disk cache keyed by Slack file id). Returns an error string for the model. */
export async function loadThreadImage(threadId: string, id: string, download: ImageDownloader = downloadSlackFile): Promise<LoadedImage | string> {
  const img = await getThreadImage(threadId, id);
  if (!img) return `Unknown image "${id}". Only image ids shown in this thread's context (img_N) can be read.`;
  const label = `img_${img.n}`;
  let processed: { mediaType: LoadedImage['mediaType']; width: number; height: number; data: Buffer } | null = await readCache(img.fileId);
  if (!processed) {
    try {
      const raw = await download(img);
      const p = await processImage(raw, { mimetype: img.mimetype, name: img.name });
      await writeCache(img.fileId, p).catch((err) => log.warn({ err }, 'image cache write failed'));
      processed = p;
    } catch (err) {
      log.warn({ err, threadId, id }, 'read_image failed');
      return `Could not load ${label}: ${errMsg(err)}`;
    }
  }
  return { id: label, name: img.name, mediaType: processed.mediaType, data: processed.data.toString('base64'), width: processed.width, height: processed.height };
}

registerTool({
  name: 'read_image',
  roles: ['front', 'child'],
  build: (ctx) => {
    const queue = getExtra(ctx.extras, EXTRAS.queueUserImage);
    return tool({
      description: 'Look at an image from this thread by its id (e.g. "img_3" from an [image img_3: …] placeholder).',
      inputSchema: z.object({ id: z.string().describe('Image id, e.g. img_3') }),
      execute: async ({ id }): Promise<LoadedImage | string> => {
        const res = await loadThreadImage(ctx.threadId, id);
        if (typeof res === 'string' || !queue) return res;
        await queue({ id: res.id, mediaType: res.mediaType, data: res.data });
        return `Image ${res.id} loaded (${res.width}×${res.height}); it is attached below as a user message.`;
      },
      toModelOutput: ({ output }) => {
        if (typeof output === 'string') return { type: 'text', value: output };
        return {
          type: 'content',
          value: [
            { type: 'text', text: `Image ${output.id}${output.name ? ` (${output.name})` : ''}, ${output.width}×${output.height}:` },
            { type: 'file', mediaType: output.mediaType, data: { type: 'data', data: output.data } },
          ],
        };
      },
    });
  },
});
