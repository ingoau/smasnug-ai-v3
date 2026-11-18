/**
 * Large files (docs/sandbox.md "Large files"): created files over limits.fileMaxBytes (Postgres keeps at most that),
 * up to limits.largeFileMaxBytes (Slack's 1 GB upload limit). Only save_url and sandbox_export make them.
 *
 * - Bytes never sit in memory: they stream to a temp file on local disk (`stage*`, hashed and capped on the way),
 *   then up to Slack as a private upload of the bot's (files.getUploadURLExternal → POST → files.completeUploadExternal
 *   without a channel: shared nowhere). That Slack file is the storage: `files.blob_slack_file_id`, content null.
 * - It is an ordinary file id: listed with run results, attachable with reply(files) / send_message(files). Posting
 *   copies it (download to a temp file, upload as a new Slack file into the thread: `copyLargeFileTo`), like any
 *   stored file is uploaded each time it is posted. It can't be opened (read_file / ask_file / sandbox_import).
 * - Every blob is also in `file_blobs` (no FK); `sweepLargeFileBlobs` deletes from Slack the blobs whose file row
 *   is gone (retention), run at most hourly after a new large file.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { limits } from '../config.js';
import { redis } from '../core/redis.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { safeFetch, type SafeFetchResult } from '../tools/safe-fetch.js';
import { decideMime, formatBytes, sanitizeDescription, sanitizeFileName, uploadContentType } from './format.js';
import { newFileId } from './ids.js';
import { downloadSlackFileTo } from './slack-download.js';
import { createFile, FileError, fileByIdempotencyKey, insertCreatedFile, type CreateFileInput, type FileMeta } from './store.js';

const FAKE = () => process.env.SLACK_FAKE === '1';
/** Bytes kept from the start of a staged file (type sniffing, the HTML-page check). */
const HEAD_BYTES = 4096;

// ---------- limits ----------

export type StorageTier = 'store' | 'large' | 'too_large';

/** Where a created file of `size` bytes goes: Postgres (≤ storeMax), a large file (≤ largeMax), or nowhere. */
export function storageTier(size: number, storeMax: number = limits.fileMaxBytes, largeMax: number = limits.largeFileMaxBytes): StorageTier {
  if (size <= storeMax) return 'store';
  if (size <= largeMax) return 'large';
  return 'too_large';
}

/** Model-facing refusal for a file over Slack's limit. */
export function tooLargeText(what: string, size: number | null): string {
  const s = size == null ? `larger than ${formatBytes(limits.largeFileMaxBytes)}` : formatBytes(size);
  return `${what} is ${s}; the most the bot can post to Slack is ${formatBytes(limits.largeFileMaxBytes)} (Slack's upload limit). Compress or split it, or share a link to it instead.`;
}

/** Time allowed to move `size` bytes to or from Slack (≥ 256 KB/s, at least a minute, at most 30 minutes). */
export function transferTimeoutMs(size: number): number {
  return Math.min(30 * 60_000, 60_000 + Math.ceil(size / (256 * 1024)) * 1000);
}

export class TooLargeError extends FileError {}

// ---------- staging ----------

export interface StagedFile {
  path: string;
  size: number;
  sha256: string;
  /** The first bytes (≤ 4 KB). */
  head: Buffer;
  cleanup(): Promise<void>;
}

/** Counts, hashes and keeps the head of what passes through; errors past `maxBytes`. */
export class Meter extends Transform {
  size = 0;
  readonly hash = createHash('sha256');
  private headParts: Buffer[] = [];
  private headLen = 0;
  constructor(private readonly maxBytes: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.size += buf.length;
    if (this.size > this.maxBytes) return cb(new TooLargeError(`larger than ${formatBytes(this.maxBytes)}`));
    this.hash.update(buf);
    if (this.headLen < HEAD_BYTES) {
      const part = buf.subarray(0, HEAD_BYTES - this.headLen);
      this.headParts.push(part);
      this.headLen += part.length;
    }
    cb(null, buf);
  }
  head(): Buffer {
    return Buffer.concat(this.headParts);
  }
}

async function tempFile(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'smasnug-file-'));
  return { path: join(dir, 'data'), cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

/** Write a stream to a temp file (at most `maxBytes`, else TooLargeError). The caller cleans up. */
export async function stageStream(source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream, maxBytes: number): Promise<StagedFile> {
  const tmp = await tempFile();
  const meter = new Meter(maxBytes);
  try {
    await pipeline(source, meter, createWriteStream(tmp.path));
  } catch (err) {
    await tmp.cleanup();
    throw err;
  }
  return { path: tmp.path, size: meter.size, sha256: meter.hash.digest('hex'), head: meter.head(), cleanup: tmp.cleanup };
}

/**
 * Download a URL to a temp file through safeFetch (SSRF filtering, redirects, deadline), at most `maxBytes`. Any HTTP
 * status comes back (the caller decides); over the cap → TooLargeError. The caller cleans up `staged`.
 */
export async function stageDownload(
  url: string,
  opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal; maxRedirects?: number; allowIPAddressList?: string[] },
): Promise<{ res: SafeFetchResult; staged: StagedFile }> {
  const tmp = await tempFile();
  const meter = new Meter(opts.maxBytes);
  const ac = new AbortController();
  let pipeErr: unknown = null;
  const piping = pipeline(meter, createWriteStream(tmp.path)).catch((err: unknown) => {
    pipeErr = err;
    ac.abort();
    throw err;
  });
  piping.catch(() => {});
  try {
    const res = await safeFetch(url, {
      // One byte over the cap tells "exactly the cap" from "bigger".
      maxBytes: opts.maxBytes + 1,
      timeoutMs: opts.timeoutMs,
      maxRedirects: opts.maxRedirects ?? 5,
      sink: meter,
      signal: opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal,
      ...(opts.allowIPAddressList ? { allowIPAddressList: opts.allowIPAddressList } : {}),
    });
    if (res.truncated) throw new TooLargeError(`larger than ${formatBytes(opts.maxBytes)}`);
    meter.end();
    await piping;
    return { res, staged: { path: tmp.path, size: meter.size, sha256: meter.hash.digest('hex'), head: meter.head(), cleanup: tmp.cleanup } };
  } catch (err) {
    // The pipe failed first (the cap, a disk error): that error, not the abort it caused.
    const first = pipeErr;
    meter.destroy();
    await piping.catch(() => {});
    await tmp.cleanup();
    throw first ?? err;
  }
}

// ---------- moving bytes to Slack ----------

/**
 * POST a file on disk to an upload URL (files.getUploadURLExternal's) with a Content-Length, streamed. Throws unless
 * the response is 2xx.
 */
export async function postFileTo(uploadUrl: string, path: string, size: number, contentType: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  const url = new URL(uploadUrl);
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]) : AbortSignal.timeout(opts.timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'POST', headers: { 'content-type': contentType, 'content-length': String(size) }, signal },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        res.on('end', () => (status >= 200 && status < 300 ? resolve() : reject(new Error(`file upload failed: HTTP ${status}`))));
        res.on('error', reject);
      },
    );
    req.on('error', (err) => reject(err.name === 'AbortError' ? new Error('file upload timed out') : err));
    pipeline(createReadStream(path), req).catch(reject);
  });
}

/** Upload a staged file to Slack privately (shared nowhere). Returns its Slack file id. */
async function uploadPrivately(staged: StagedFile, filename: string, idempotencyKey: string, signal?: AbortSignal): Promise<string> {
  const res = await slackCall<any>('files.getUploadURLExternal', { filename, length: staged.size });
  if (!res?.upload_url || !res?.file_id) throw new Error('files.getUploadURLExternal returned no upload_url');
  if (!FAKE()) await postFileTo(res.upload_url, staged.path, staged.size, uploadContentType(filename), { timeoutMs: transferTimeoutMs(staged.size), ...(signal ? { signal } : {}) });
  const done = await slackCall<any>('files.completeUploadExternal', { files: [{ id: res.file_id, title: filename }] }, { idempotencyKey });
  return (Array.isArray(done?.files) && typeof done.files[0]?.id === 'string' ? done.files[0].id : null) ?? res.file_id;
}

/**
 * Copy a large file into a new Slack upload (`uploadUrl`, from files.getUploadURLExternal with length = meta.size):
 * downloaded from its private Slack copy to a temp file, then streamed up. Under SLACK_FAKE nothing moves.
 */
export async function copyLargeFileTo(meta: FileMeta, uploadUrl: string, contentType: string, signal?: AbortSignal): Promise<void> {
  if (!meta.blobSlackFileId || meta.size == null) throw new FileError(`${meta.id} is not a large file`);
  if (FAKE()) return;
  const info = await slackCall<any>('files.info', { file: meta.blobSlackFileId, count: 1 }, { maxWaitMs: 10_000 }).catch((err) => {
    if (slackErrorCode(err) === 'file_not_found' || slackErrorCode(err) === 'file_deleted') throw new FileError(`${meta.id} is no longer available (its stored copy is gone)`);
    throw err;
  });
  const src = info?.file?.url_private_download ?? info?.file?.url_private;
  if (typeof src !== 'string') throw new Error('files.info returned no download URL for a large file');
  const tmp = await tempFile();
  try {
    const out = createWriteStream(tmp.path);
    const written = await downloadSlackFileTo(src, out, {
      maxBytes: meta.size + 1,
      timeoutMs: transferTimeoutMs(meta.size),
      expectHtml: (meta.mime ?? '').startsWith('text/html'),
      ...(signal ? { signal } : {}),
    }).finally(() => out.end());
    await new Promise<void>((resolve, reject) => (out.writableFinished ? resolve() : out.once('finish', resolve).once('error', reject)));
    if (written !== meta.size) throw new Error(`downloaded ${written} of ${meta.size} bytes of a large file`);
    await postFileTo(uploadUrl, tmp.path, meta.size, contentType, { timeoutMs: transferTimeoutMs(meta.size), ...(signal ? { signal } : {}) });
  } finally {
    await tmp.cleanup();
  }
}

// ---------- creating ----------

export type StagedFileInput = Omit<CreateFileInput, 'content' | 'maxBytes'>;

/**
 * Store a staged file as a created file: in Postgres when it fits (≤ `storeMax`, default limits.fileMaxBytes; read
 * into memory, so only small ones), else as a large file (≤ limits.largeFileMaxBytes), else TooLargeError. Doesn't
 * clean up `staged`.
 */
export async function createFileFromStaged(input: StagedFileInput, staged: StagedFile, opts: { storeMax?: number; signal?: AbortSignal } = {}): Promise<FileMeta> {
  const tier = storageTier(staged.size, opts.storeMax ?? limits.fileMaxBytes);
  if (tier === 'too_large') throw new TooLargeError(tooLargeText('The file', staged.size));
  if (tier === 'store') {
    return createFile({ ...input, content: await readFile(staged.path), maxBytes: opts.storeMax ?? limits.fileMaxBytes });
  }
  return createLargeFile(input, staged, opts.signal);
}

/** A staged file over the store's cap → a large file (see the header). Idempotent per `idempotencyKey`. */
export async function createLargeFile(input: StagedFileInput, staged: StagedFile, signal?: AbortSignal): Promise<FileMeta> {
  if (staged.size > limits.largeFileMaxBytes) throw new TooLargeError(tooLargeText('The file', staged.size));
  if (input.idempotencyKey) {
    const existing = await fileByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
  }
  const name = sanitizeFileName(input.name);
  const mime = input.mime ?? decideMime(name, staged.head);
  const description = sanitizeDescription(input.description) || null;
  let id = newFileId();
  const slackFileId = await uploadPrivately(staged, name, `large-file:${input.idempotencyKey ?? id}`, signal);
  for (let attempt = 0; attempt < 5; attempt++, id = newFileId()) {
    // Recorded first: a row that never makes it leaves a blob the sweep deletes.
    await sql`insert into file_blobs (slack_file_id, file_id) values (${slackFileId}, ${id})
      on conflict (slack_file_id) do update set file_id = excluded.file_id`;
    const row = await insertCreatedFile(id, { ...input, name, description }, { content: null, size: staged.size, sha256: staged.sha256, mime, blobSlackFileId: slackFileId });
    if (row) {
      void maybeSweep();
      return row;
    }
    if (input.idempotencyKey) {
      const existing = await fileByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }
  }
  throw new Error('createLargeFile: could not allocate a file id');
}

// ---------- cleanup ----------

async function maybeSweep(): Promise<void> {
  try {
    if ((await redis.set('files:blob-sweep', '1', 'EX', 3600, 'NX')) !== 'OK') return;
    const n = await sweepLargeFileBlobs();
    if (n) log.info({ n }, 'deleted Slack copies of removed large files');
  } catch (err) {
    log.warn({ err }, 'large file blob sweep failed');
  }
}

/**
 * Delete from Slack the private copies of large files whose row is gone (retention, deletion), older than an hour
 * (a copy whose row is still being written is left alone). Returns how many were removed.
 */
export async function sweepLargeFileBlobs(limit = 50): Promise<number> {
  const rows = await sql<{ slackFileId: string }[]>`
    select slack_file_id from file_blobs b
    where b.created_at < now() - interval '1 hour' and not exists (select 1 from files f where f.id = b.file_id)
    order by b.created_at limit ${limit}`;
  let n = 0;
  for (const { slackFileId } of rows) {
    try {
      await slackCall('files.delete', { file: slackFileId }, { idempotencyKey: `file-blob-delete:${slackFileId}` });
    } catch (err) {
      const code = slackErrorCode(err);
      if (code !== 'file_not_found' && code !== 'file_deleted') {
        log.warn({ err, slackFileId }, 'deleting a large file blob from Slack failed');
        continue;
      }
    }
    await sql`delete from file_blobs where slack_file_id = ${slackFileId}`;
    n++;
  }
  return n;
}
