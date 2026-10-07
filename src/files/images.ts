/**
 * Images for the model: a stored or uploaded image file → resized (≤1500px on the long side), HEIC converted, GIF
 * first frame (tools/image-process.ts), cached on disk by Slack file id (uploads) or file id. Used by read_file (the
 * image goes into the model's context as a tool-result image part) and ask_file / descriptions (vision calls).
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import { processImage } from '../tools/image-process.js';
import { loadFileBytes, type FileDownloader, type FileMeta } from './store.js';

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

const cachePaths = (key: string) => {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, '_');
  return { bin: path.join(IMAGE_CACHE_DIR, `${safe}.bin`), meta: path.join(IMAGE_CACHE_DIR, `${safe}.json`) };
};

async function readCache(key: string) {
  const p = cachePaths(key);
  try {
    const meta = JSON.parse(await readFile(p.meta, 'utf8')) as { mediaType: LoadedImage['mediaType']; width: number; height: number };
    return { ...meta, data: await readFile(p.bin) };
  } catch {
    return null;
  }
}

async function writeCache(key: string, img: { mediaType: string; width: number; height: number; data: Buffer }) {
  const p = cachePaths(key);
  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  await writeFile(p.bin, img.data);
  await writeFile(p.meta, JSON.stringify({ mediaType: img.mediaType, width: img.width, height: img.height }));
}

/** Delete cached images older than `maxAgeMs` (registered as a maintenance task). */
export async function pruneImageCache(maxAgeMs: number): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(IMAGE_CACHE_DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    const p = path.join(IMAGE_CACHE_DIR, name);
    try {
      if ((await stat(p)).mtimeMs < cutoff) {
        await rm(p, { force: true });
        removed++;
      }
    } catch {
      /* raced with another worker */
    }
  }
  return removed;
}

/** Cache key: the Slack file id for uploads (stable across re-registration), else the file id. */
export const imageCacheKey = (meta: Pick<FileMeta, 'id' | 'slackFileId'>) => meta.slackFileId ?? meta.id;

/** Load + process an image file for a model (throws on failure). */
export async function loadImageForModel(meta: FileMeta, opts: { download?: FileDownloader } = {}): Promise<LoadedImage> {
  const key = imageCacheKey(meta);
  let processed: { mediaType: LoadedImage['mediaType']; width: number; height: number; data: Buffer } | null = await readCache(key);
  if (!processed) {
    const raw = await loadFileBytes(meta, opts);
    processed = await processImage(raw, { mimetype: meta.mime, name: meta.name });
    await writeCache(key, processed).catch((err) => log.warn({ err }, 'image cache write failed'));
  }
  return { id: meta.id, name: meta.name, mediaType: processed.mediaType, data: processed.data.toString('base64'), width: processed.width, height: processed.height };
}
