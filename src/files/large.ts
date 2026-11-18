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
 *   is gone (retention), run by the retention job and at most hourly after a new large file. A privacy withdrawal
 *   deletes the user's files and their blobs at once (`deleteFilesOwnedBy`).
 * - Abuse / resource guards (`LargeGate`): a per-user hourly byte budget, a bot-wide cap on transfers at once (Redis
 *   semaphore with a TTL) and a free-disk check on the temp dir, all checked as soon as a staging is known to be
 *   large (its size, a Content-Length, or crossing the store's cap mid-stream).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { limits } from '../config.js';
import { redis } from '../core/redis.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { safeFetch, type SafeFetchResult } from '../tools/safe-fetch.js';
import { decideMime, formatBytes, sanitizeDescription, sanitizeFileName, transferTimeoutMs, uploadContentType } from './format.js';
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

export { transferTimeoutMs };

export class TooLargeError extends FileError {}
/** A large file refused for now (the user's hourly budget, the bot busy with others, low disk): the message says why. */
export class LargeFileRefusedError extends FileError {}

// ---------- guards: budget, concurrency, disk ----------

const TEMP_PREFIX = 'smasnug-file-';
const SLOTS_KEY = 'files:large-transfers';
/** A slot outlives the longest transfer (30 min each way) and is freed by a crashed worker only by expiring. */
const SLOT_TTL_MS = 65 * 60_000;
const HOUR_MS = 3600_000;
const budgetKey = (userId: string, now = Date.now()) => `files:large-bytes:${userId}:${Math.floor(now / HOUR_MS)}`;

/** Free bytes on the temp dir's filesystem (Infinity if unknown). */
export async function freeTempBytes(): Promise<number> {
  try {
    const s = await statfs(tmpdir());
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

const ACQUIRE = `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
if redis.call('zcard', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
  redis.call('pexpire', KEYS[1], ARGV[5])
  return 1
end
return 0`;

/**
 * Take one of the bot-wide large-transfer slots (limits.largeFileConcurrentTransfers), waiting up to `waitMs`.
 * Returns its release function, or null if none came free.
 */
export async function acquireTransferSlot(waitMs = 0, signal?: AbortSignal): Promise<(() => Promise<void>) | null> {
  const token = randomUUID();
  const until = Date.now() + waitMs;
  for (;;) {
    const now = Date.now();
    const got = await redis.eval(ACQUIRE, 1, SLOTS_KEY, String(now), String(limits.largeFileConcurrentTransfers), String(now + SLOT_TTL_MS), token, String(SLOT_TTL_MS));
    if (Number(got) === 1) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await redis.zrem(SLOTS_KEY, token).catch(() => {});
      };
    }
    if (Date.now() >= until || signal?.aborted) return null;
    await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(0, until - Date.now()))));
  }
}

const busyText = () => 'The bot is busy moving other large files right now. Try again in a few minutes.';
const diskText = (need: number | null) =>
  `There isn't enough free disk space to take ${need == null ? 'a file this large' : `a ${formatBytes(need)} file`} right now. Try again later, or share a link to it instead.`;

/**
 * Guards one large staging (see the header): `reserve` is called once the staging is known to be large (with its
 * expected size, if known), takes a transfer slot and checks the user's budget and the disk, and returns how many
 * bytes the staging may reach (with the error for going past that). `finish` charges what was staged to the user's
 * budget and frees the slot; it is idempotent.
 */
export interface LargeGate {
  /** Bytes a staging may reach before it counts as large (the store's cap). */
  threshold: number;
  reserve(expected: number | null): Promise<{ allowed: number; overError: () => Error }>;
  finish(stagedBytes: number): Promise<void>;
}

export function largeGate(userId: string | null, threshold: number, opts: { signal?: AbortSignal } = {}): LargeGate {
  let release: (() => Promise<void>) | null = null;
  let attempted = false;
  let reserved = false;
  let done = false;
  return {
    threshold,
    async reserve(expected) {
      if (attempted) throw new Error('largeGate: reserved twice');
      attempted = true;
      if (expected != null && expected > limits.largeFileMaxBytes) throw new TooLargeError(tooLargeText('The file', expected));
      const used = userId ? Number((await redis.get(budgetKey(userId))) ?? 0) : 0;
      const budgetLeft = userId ? Math.max(0, limits.largeFileBytesPerUserHour - used) : Infinity;
      const budgetErr = () => {
        const mins = Math.ceil((HOUR_MS - (Date.now() % HOUR_MS)) / 60_000);
        return new LargeFileRefusedError(
          `Large files (over ${formatBytes(threshold)}) are limited to ${formatBytes(limits.largeFileBytesPerUserHour)} per person per hour, and ${formatBytes(used)} of that is used. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or share a link instead.`,
        );
      };
      if (budgetLeft <= threshold || (expected != null && expected > budgetLeft)) throw budgetErr();
      const slot = await acquireTransferSlot(0, opts.signal);
      if (!slot) throw new LargeFileRefusedError(busyText());
      release = slot;
      const disk = Math.max(0, (await freeTempBytes()) - limits.largeFileDiskMarginBytes);
      if (disk <= threshold || (expected != null && expected > disk)) {
        await release();
        throw new LargeFileRefusedError(diskText(expected));
      }
      const allowed = Math.min(limits.largeFileMaxBytes, budgetLeft, disk);
      const overError = () =>
        allowed === limits.largeFileMaxBytes
          ? new TooLargeError(`larger than ${formatBytes(allowed)}`)
          : allowed === budgetLeft
            ? budgetErr()
            : new LargeFileRefusedError(diskText(null));
      reserved = true;
      return { allowed, overError };
    },
    async finish(stagedBytes) {
      if (done) return;
      done = true;
      if (reserved && userId && stagedBytes > 0) {
        const key = budgetKey(userId);
        await redis
          .multi()
          .incrby(key, stagedBytes)
          .pexpire(key, 2 * HOUR_MS)
          .exec()
          .catch((err) => log.warn({ err }, 'charging a large file to the hourly budget failed'));
      }
      await release?.();
    },
  };
}

// ---------- staging ----------

export interface StagedFile {
  path: string;
  size: number;
  sha256: string;
  /** The first bytes (≤ 4 KB). */
  head: Buffer;
  cleanup(): Promise<void>;
}

/**
 * Counts, hashes and keeps the head of what passes through; errors past `maxBytes`. With a gate, crossing
 * `gate.threshold` reserves the large-file guards first (or errors with their refusal), which may lower the cap.
 */
export class Meter extends Transform {
  size = 0;
  readonly hash = createHash('sha256');
  private headParts: Buffer[] = [];
  private headLen = 0;
  private reservation: Promise<void> | null = null;
  private overError: () => Error;
  constructor(
    private maxBytes: number,
    private readonly gate?: LargeGate,
  ) {
    super();
    this.overError = () => new TooLargeError(`larger than ${formatBytes(this.maxBytes)}`);
  }
  /** Reserve the gate (once), e.g. up front when the size is known. */
  reserve(expected: number | null): Promise<void> {
    if (!this.gate) return Promise.resolve();
    this.reservation ??= this.gate.reserve(expected).then(({ allowed, overError }) => {
      if (allowed < this.maxBytes) {
        this.maxBytes = allowed;
        this.overError = overError;
      }
    });
    return this.reservation;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.gate && !this.reservation && this.size + buf.length > this.gate.threshold) {
      this.reserve(null).then(() => this.accept(buf, cb), (err: Error) => cb(err));
      return;
    }
    this.accept(buf, cb);
  }
  private accept(buf: Buffer, cb: TransformCallback): void {
    this.size += buf.length;
    if (this.size > this.maxBytes) return cb(this.overError());
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

async function tempFile(gate?: LargeGate, meter?: Meter): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  return {
    path: join(dir, 'data'),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await gate?.finish(meter?.size ?? 0).catch(() => {});
    },
  };
}

/**
 * Write a stream to a temp file (at most `maxBytes`, else TooLargeError). With a gate, a staging past its threshold
 * (or `expected` past it: checked before reading anything) needs the large-file guards. The caller cleans up.
 */
export async function stageStream(
  source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  maxBytes: number,
  opts: { gate?: LargeGate; expected?: number } = {},
): Promise<StagedFile> {
  const meter = new Meter(maxBytes, opts.gate);
  const tmp = await tempFile(opts.gate, meter);
  try {
    if (opts.gate && opts.expected != null && opts.expected > opts.gate.threshold) await meter.reserve(opts.expected);
    await pipeline(source, meter, createWriteStream(tmp.path));
  } catch (err) {
    await tmp.cleanup();
    throw err;
  }
  return { path: tmp.path, size: meter.size, sha256: meter.hash.digest('hex'), head: meter.head(), cleanup: tmp.cleanup };
}

/**
 * Download a URL to a temp file through safeFetch (SSRF filtering, redirects, deadline), at most `maxBytes`. Any HTTP
 * status comes back (the caller decides), but only a 2xx body is written to disk (others: `staged` is empty). Over the
 * cap → TooLargeError. With a gate, as stageStream (a Content-Length counts as `expected`). The caller cleans up
 * `staged`.
 */
export async function stageDownload(
  url: string,
  opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal; maxRedirects?: number; allowIPAddressList?: string[]; gate?: LargeGate },
): Promise<{ res: SafeFetchResult; staged: StagedFile }> {
  const meter = new Meter(opts.maxBytes, opts.gate);
  const tmp = await tempFile(opts.gate, meter);
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
      // Before any byte is written: a declared size over the cap is refused, one past the store's is reserved.
      sinkIf: async ({ headers }) => {
        const len = Number(headers['content-length']);
        if (Number.isFinite(len) && len > 0 && !headers['content-encoding']) {
          if (len > opts.maxBytes) throw new TooLargeError(`larger than ${formatBytes(opts.maxBytes)}`);
          if (opts.gate && len > opts.gate.threshold) await meter.reserve(len);
        }
        return true;
      },
      signal: opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal,
      ...(opts.allowIPAddressList ? { allowIPAddressList: opts.allowIPAddressList } : {}),
    });
    if (res.truncated && res.sunk !== false) throw new TooLargeError(`larger than ${formatBytes(opts.maxBytes)}`);
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
  // A copy is staged on disk too: it takes a transfer slot (waiting a while for one) and needs the room.
  const release = await acquireTransferSlot(2 * 60_000, signal);
  if (!release) throw new LargeFileRefusedError(`${meta.id} couldn't be posted: ${busyText()}`);
  try {
    if ((await freeTempBytes()) - limits.largeFileDiskMarginBytes < meta.size) throw new LargeFileRefusedError(`${meta.id} couldn't be posted: ${diskText(meta.size)}`);
    const tmp = await tempFile();
    try {
      const out = createWriteStream(tmp.path);
      // Listening before any byte is written: a disk error (ENOSPC) aborts the download instead of going unhandled.
      const ac = new AbortController();
      let outErr: unknown = null;
      out.on('error', (err) => {
        outErr ??= err;
        ac.abort();
      });
      let written: number;
      try {
        written = await downloadSlackFileTo(src, out, {
          maxBytes: meta.size + 1,
          timeoutMs: transferTimeoutMs(meta.size),
          expectHtml: (meta.mime ?? '').startsWith('text/html'),
          signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal,
        });
        out.end();
        await finished(out);
      } catch (err) {
        out.destroy();
        throw outErr ?? err;
      }
      if (written !== meta.size) throw new Error(`downloaded ${written} of ${meta.size} bytes of a large file`);
      await postFileTo(uploadUrl, tmp.path, meta.size, contentType, { timeoutMs: transferTimeoutMs(meta.size), ...(signal ? { signal } : {}) });
    } finally {
      await tmp.cleanup();
    }
  } finally {
    await release();
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
    await sweepLargeFiles();
  } catch (err) {
    log.warn({ err }, 'large file blob sweep failed');
  }
}

/** The retention job's step (and the hourly one after a new large file): blobs of deleted files, stale temp dirs. */
export async function sweepLargeFiles(): Promise<{ blobs: number; tempDirs: number }> {
  let blobs = 0;
  // Batches until a short one (a long backlog after retention), bounded per run.
  for (let i = 0; i < 20; i++) {
    const n = await sweepLargeFileBlobs(50);
    blobs += n;
    if (n < 50) break;
  }
  const tempDirs = await removeStaleTempDirs();
  if (blobs || tempDirs) log.info({ blobs, tempDirs }, 'large files: deleted Slack copies of removed files / stale temp dirs');
  return { blobs, tempDirs };
}

/** Delete one blob from Slack (gone already counts) and forget it. False if Slack refused. */
async function deleteBlob(slackFileId: string): Promise<boolean> {
  try {
    await slackCall('files.delete', { file: slackFileId }, { idempotencyKey: `file-blob-delete:${slackFileId}` });
  } catch (err) {
    const code = slackErrorCode(err);
    if (code !== 'file_not_found' && code !== 'file_deleted') {
      log.warn({ err, slackFileId }, 'deleting a large file blob from Slack failed');
      return false;
    }
  }
  await sql`delete from file_blobs where slack_file_id = ${slackFileId}`;
  return true;
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
  for (const { slackFileId } of rows) if (await deleteBlob(slackFileId)) n++;
  return n;
}

/**
 * Privacy withdrawal: delete every file owned by `userId` (made for them, or their uploads' stored copies) and, right
 * away, the Slack copies of their large files (no grace period). Returns how many files were deleted.
 */
export async function deleteFilesOwnedBy(userId: string): Promise<number> {
  const rows = await sql<{ id: string }[]>`delete from files where owner_id = ${userId} returning id`;
  if (rows.length) {
    const blobs = await sql<{ slackFileId: string }[]>`
      select slack_file_id from file_blobs b
      where b.file_id in ${sql(rows.map((r) => r.id))} and not exists (select 1 from files f where f.id = b.file_id)`;
    for (const { slackFileId } of blobs) await deleteBlob(slackFileId);
  }
  return rows.length;
}

/** Remove staging temp dirs (TEMP_PREFIX) older than `maxAgeMs`: left by a crashed or killed worker. */
export async function removeStaleTempDirs(maxAgeMs = 24 * HOUR_MS, dir = tmpdir()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let n = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true });
      n++;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return n;
}
