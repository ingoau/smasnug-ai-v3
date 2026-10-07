/**
 * File store (design doc, "Files"): one global `files` table, thread-scoped access (access.ts).
 *
 * - `FileStore` is the storage seam: content + metadata by id (put/get/getRange/metadata/delete). Content lives in
 *   Postgres (bytea) for now; moving it (e.g. to object storage) only touches `PgFileStore`.
 * - Created files (`createFile`): the bot's own (create_file, reply's inline files; later sandbox exports). Content is
 *   stored right away; the creator gives the one-line description.
 * - Uploads (`registerSlackFiles`): Slack files on messages shown to a model are registered per thread with metadata
 *   only; the content is downloaded with the bot token on first use (`loadFileBytes`) and kept when ≤ the size cap.
 *   Files on `##` messages never get here (those messages are never stored or rendered).
 * - Everything a model can name goes through `resolveFile`, which applies the access rule.
 */
import { createHash } from 'node:crypto';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { parseThreadId } from '../core/events.js';
import type { SlackFileRef } from '../core/types.js';
import type { RenderMsg } from '../context/format.js';
import { canUseFile, type FileAccessContext } from './access.js';
import { decideMime, fileKind, formatBytes, isImageMime, mimeFromName, sanitizeDescription, sanitizeFileName, sniffMime, type ContextFile, type FileListing } from './format.js';
import { newFileId, parseFileRef } from './ids.js';
import { downloadSlackFile, MAX_IMAGE_DOWNLOAD_BYTES } from './slack-download.js';

export interface FileMeta {
  id: string;
  createdAt: Date;
  origin: 'upload' | 'created';
  internal: boolean;
  threadId: string;
  channelId: string;
  ownerId: string | null;
  createdTurnId: number | null;
  createdRunId: number | null;
  createdSubagentId: string | null;
  slackFileId: string | null;
  slackUrl: string | null;
  messageTs: string | null;
  name: string;
  mime: string | null;
  size: number | null;
  description: string | null;
  descriptionSource: 'creator' | 'model' | null;
  sha256: string | null;
  legacyImageN: number | null;
  /** The content is stored (uploads: fetched). */
  hasContent: boolean;
}

/** Storage seam: where file content (and its metadata row) lives. */
export interface FileStore {
  /** Store the content of an existing file row (sets size and sha256). */
  put(id: string, bytes: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | null>;
  /** Bytes [start, end) of the content (null: no such file or no content yet). */
  getRange(id: string, start: number, end: number): Promise<Buffer | null>;
  metadata(id: string): Promise<FileMeta | null>;
  delete(id: string): Promise<void>;
}

const META = () => sql`id, created_at, origin, internal, thread_id, channel_id, owner_id, created_turn_id, created_run_id,
  created_subagent_id, slack_file_id, slack_url, message_ts, name, mime, size, description, description_source, sha256,
  legacy_image_n, content is not null as has_content`;

function normalizeMeta(r: FileMeta): FileMeta {
  return {
    ...r,
    size: r.size == null ? null : Number(r.size),
    createdTurnId: r.createdTurnId == null ? null : Number(r.createdTurnId),
    createdRunId: r.createdRunId == null ? null : Number(r.createdRunId),
  };
}

export class PgFileStore implements FileStore {
  async put(id: string, bytes: Buffer): Promise<void> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    await sql`update files set content = ${bytes}, size = ${bytes.byteLength}, sha256 = ${sha} where id = ${id}`;
  }

  async get(id: string): Promise<Buffer | null> {
    const [r] = await sql<{ content: Buffer | null }[]>`select content from files where id = ${id}`;
    return r?.content ?? null;
  }

  async getRange(id: string, start: number, end: number): Promise<Buffer | null> {
    const from = Math.max(0, Math.floor(start));
    const len = Math.max(0, Math.floor(end) - from);
    const [r] = await sql<{ part: Buffer | null }[]>`select substring(content from ${from + 1} for ${len}) as part from files where id = ${id}`;
    return r?.part ?? null;
  }

  async metadata(id: string): Promise<FileMeta | null> {
    const [r] = await sql<FileMeta[]>`select ${META()} from files where id = ${id}`;
    return r ? normalizeMeta(r) : null;
  }

  async delete(id: string): Promise<void> {
    await sql`delete from files where id = ${id}`;
  }
}

export const fileStore: FileStore = new PgFileStore();

export class FileError extends Error {}

// ---------- created files ----------

export interface CreateFileInput {
  threadId: string;
  /** The speaker the file is made for (subagents: their owner). */
  ownerId: string;
  name: string;
  content: Buffer;
  description: string;
  /** Default: sniffed from the content, then the extension. */
  mime?: string;
  createdTurnId?: number | null;
  createdRunId?: number | null;
  createdSubagentId?: string | null;
  /** Same key → the same file (no duplicate for a retried side effect). */
  idempotencyKey?: string;
  internal?: boolean;
  /**
   * Size cap for this file (default limits.fileMaxBytes, 5 MB). Only the sandbox raises it, for its exports and
   * preview bundles (limits.sandboxExportMaxBytes, 25 MB); everything else keeps the general cap.
   */
  maxBytes?: number;
}

export async function createFile(input: CreateFileInput): Promise<FileMeta> {
  const maxBytes = input.maxBytes ?? limits.fileMaxBytes;
  if (input.content.byteLength > maxBytes) {
    throw new FileError(`File too large: ${formatBytes(input.content.byteLength)} (the limit is ${formatBytes(maxBytes)}).`);
  }
  const name = sanitizeFileName(input.name);
  const mime = input.mime ?? decideMime(name, input.content);
  const description = sanitizeDescription(input.description) || null;
  const sha = createHash('sha256').update(input.content).digest('hex');
  const { channelId } = parseThreadId(input.threadId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newFileId();
    const rows = await sql<FileMeta[]>`
      insert into files (id, origin, internal, thread_id, channel_id, owner_id, created_turn_id, created_run_id, created_subagent_id,
                         idem_key, name, mime, size, description, description_source, content, sha256)
      values (${id}, 'created', ${input.internal ?? false}, ${input.threadId}, ${channelId}, ${input.ownerId}, ${input.createdTurnId ?? null},
              ${input.createdRunId ?? null}, ${input.createdSubagentId ?? null}, ${input.idempotencyKey ?? null}, ${name}, ${mime},
              ${input.content.byteLength}, ${description}, ${description ? 'creator' : null}, ${input.content}, ${sha})
      on conflict do nothing
      returning ${META()}`;
    if (rows[0]) return normalizeMeta(rows[0]);
    if (input.idempotencyKey) {
      const [existing] = await sql<FileMeta[]>`select ${META()} from files where idem_key = ${input.idempotencyKey}`;
      if (existing) return normalizeMeta(existing);
    }
    // Otherwise an id collision: draw again.
  }
  throw new Error('createFile: could not allocate a file id');
}

// ---------- uploads ----------

interface UploadCandidate {
  file: SlackFileRef;
  ownerId: string | null;
  messageTs: string;
}

type ContextRow = ContextFile & { slackFileId: string };

/**
 * Register the Slack files on `msgs` (shown in this thread) and return Slack file id → context info. Idempotent and
 * race-safe (unique per thread + Slack file). Metadata only: content is fetched on first use. A Slack file that is
 * the bot's own post of a stored file maps back to that file.
 */
export async function registerSlackFiles(threadId: string, msgs: RenderMsg[]): Promise<Map<string, ContextFile>> {
  const candidates: UploadCandidate[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.deleted) continue;
    for (const f of m.files ?? []) {
      if (!f?.id || seen.has(f.id)) continue;
      seen.add(f.id);
      candidates.push({ file: f, ownerId: m.botId ? null : m.userId, messageTs: m.ts });
    }
  }
  const out = new Map<string, ContextFile>();
  if (!candidates.length) return out;
  const put = (r: ContextRow) => out.set(r.slackFileId, { id: r.id, name: r.name, mime: r.mime, description: r.description });
  const ids = candidates.map((c) => c.file.id);

  const posted = await sql<ContextRow[]>`
    select p.slack_file_id, f.id, f.name, f.mime, f.description from file_posts p join files f on f.id = p.file_id
    where p.slack_file_id in ${sql(ids)} and not f.internal`;
  posted.forEach(put);
  const lookup = async () => {
    const left = ids.filter((id) => !out.has(id));
    if (!left.length) return;
    const rows = await sql<ContextRow[]>`
      select slack_file_id, id, name, mime, description from files where thread_id = ${threadId} and slack_file_id in ${sql(left)}`;
    rows.forEach(put);
  };
  await lookup();

  const { channelId } = parseThreadId(threadId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const missing = candidates.filter((c) => !out.has(c.file.id));
    if (!missing.length) break;
    const rows = missing.map((c) => ({
      id: newFileId(),
      origin: 'upload',
      thread_id: threadId,
      channel_id: channelId,
      owner_id: c.ownerId,
      slack_file_id: c.file.id,
      slack_url: c.file.urlPrivate ?? null,
      message_ts: c.messageTs,
      name: sanitizeFileName(c.file.name),
      mime: c.file.mimetype ?? mimeFromName(c.file.name) ?? null,
      size: typeof c.file.size === 'number' ? c.file.size : null,
    }));
    const inserted = await sql<ContextRow[]>`
      insert into files ${sql(rows, 'id', 'origin', 'thread_id', 'channel_id', 'owner_id', 'slack_file_id', 'slack_url', 'message_ts', 'name', 'mime', 'size')}
      on conflict do nothing
      returning slack_file_id, id, name, mime, description`;
    inserted.forEach(put);
    // Conflicts: another worker registered it (found now), or an id collision (retried with new ids).
    await lookup();
  }
  return out;
}

/**
 * Forget the uploads of a Slack message that was deleted (all its files) or edited (`slackFileIds`: the files it no
 * longer has), and the post mappings of those Slack files. Created files the bot posted stay (they are the bot's
 * deliverables, with their own retention).
 */
export async function removeMessageFiles(channelId: string, messageTs: string, slackFileIds?: string[]): Promise<number> {
  if (slackFileIds && !slackFileIds.length) return 0;
  const rows = slackFileIds
    ? await sql`delete from files where origin = 'upload' and channel_id = ${channelId} and message_ts = ${messageTs} and slack_file_id in ${sql(slackFileIds)} returning id`
    : await sql`delete from files where origin = 'upload' and channel_id = ${channelId} and message_ts = ${messageTs} returning id`;
  if (slackFileIds) await sql`delete from file_posts where slack_file_id in ${sql(slackFileIds)}`;
  return rows.length;
}

// ---------- access ----------

export interface ResolvedFile extends FileMeta {
  postedThreadIds: string[];
}

/** Same answer for "doesn't exist" and "not yours": ids can't be probed. */
export const notAvailable = (ref: string) =>
  `No file "${ref.slice(0, 60)}" is available here. Use a file id shown in this conversation (file_…), or one of the speaker's own files.`;

/** Resolve a model-given file id (or a migrated `img_N`) under the access rule. */
export async function resolveFile(ref: string, ctx: FileAccessContext): Promise<ResolvedFile | { error: string }> {
  const parsed = parseFileRef(ref);
  if (!parsed) return { error: notAvailable(ref) };
  const [row] =
    parsed.kind === 'id'
      ? await sql<ResolvedFile[]>`
          select ${META()}, coalesce((select array_agg(p.thread_id) from file_posts p where p.file_id = files.id), '{}') as posted_thread_ids
          from files where id = ${parsed.id}`
      : await sql<ResolvedFile[]>`
          select ${META()}, '{}'::text[] as posted_thread_ids
          from files where thread_id = ${ctx.threadId} and legacy_image_n = ${parsed.n} limit 1`;
  if (!row) return { error: notAvailable(ref) };
  const f = { ...normalizeMeta(row), postedThreadIds: row.postedThreadIds ?? [] };
  if (!canUseFile(f, ctx)) return { error: notAvailable(ref) };
  return f;
}

// ---------- content ----------

export type FileDownloader = (meta: FileMeta, maxBytes: number) => Promise<Buffer>;

const defaultDownloader: FileDownloader = (meta, maxBytes) => {
  if (!meta.slackUrl) throw new FileError('this upload has no download URL');
  return downloadSlackFile(meta.slackUrl, maxBytes, fileKind(meta.mime, meta.name) === 'html');
};

/**
 * The file's bytes. Uploads are downloaded on first use and stored when ≤ limits.fileMaxBytes. Larger uploads:
 * images (≤ 25 MB) are returned without storing (the processed image is cached separately); anything else is refused,
 * unless the caller allows more with `maxBytes` (sandbox_import: returned without storing, like big images).
 */
export async function loadFileBytes(meta: FileMeta, opts: { download?: FileDownloader; maxBytes?: number } = {}): Promise<Buffer> {
  if (meta.hasContent) {
    const bytes = await fileStore.get(meta.id);
    if (bytes) return bytes;
  }
  if (meta.origin !== 'upload') throw new FileError('this file has no content');
  const image = isImageMime(meta.mime, meta.name);
  const max = Math.max(image ? MAX_IMAGE_DOWNLOAD_BYTES : limits.fileMaxBytes, opts.maxBytes ?? 0);
  if (meta.size != null && meta.size > max) {
    throw new FileError(`it is too large to open (${formatBytes(meta.size)}; the limit is ${formatBytes(max)})`);
  }
  const bytes = await (opts.download ?? defaultDownloader)(meta, max);
  if (bytes.byteLength <= limits.fileMaxBytes) {
    await fileStore.put(meta.id, bytes);
    meta.hasContent = true;
    meta.size = bytes.byteLength;
    const sniffed = sniffMime(bytes);
    if (!meta.mime && sniffed) {
      meta.mime = sniffed;
      await sql`update files set mime = ${sniffed} where id = ${meta.id} and mime is null`;
    }
  } else if (!image && bytes.byteLength > (opts.maxBytes ?? 0)) {
    throw new FileError(`it is too large to open (${formatBytes(bytes.byteLength)}; the limit is ${formatBytes(limits.fileMaxBytes)})`);
  }
  return bytes;
}

export async function setDescription(id: string, description: string, source: 'creator' | 'model'): Promise<string | null> {
  const clean = sanitizeDescription(description);
  if (!clean) return null;
  await sql`update files set description = ${clean}, description_source = ${source} where id = ${id}`;
  return clean;
}

// ---------- posts ----------

/** The bot posted stored files to Slack (Slack file id of each copy). */
export async function recordFilePosts(posts: { fileId: string; slackFileId: string; channelId: string; threadId: string }[]): Promise<void> {
  if (!posts.length) return;
  const rows = posts.map((p) => ({ slack_file_id: p.slackFileId, file_id: p.fileId, channel_id: p.channelId, thread_id: p.threadId }));
  await sql`insert into file_posts ${sql(rows, 'slack_file_id', 'file_id', 'channel_id', 'thread_id')} on conflict (slack_file_id) do nothing`;
}

// ---------- listings ----------

/** Files each run created (not internal), for the front agent's view of subagent results. */
export async function filesCreatedByRuns(runIds: number[]): Promise<Map<number, FileListing[]>> {
  const out = new Map<number, FileListing[]>();
  if (!runIds.length) return out;
  const rows = await sql<(FileListing & { createdRunId: number })[]>`
    select created_run_id, id, name, mime, size, description from files
    where created_run_id in ${sql(runIds)} and not internal order by created_at, id`;
  for (const r of rows) {
    const k = Number(r.createdRunId);
    const list = out.get(k) ?? [];
    list.push({ id: r.id, name: r.name, mime: r.mime, size: r.size == null ? null : Number(r.size), description: r.description });
    out.set(k, list);
  }
  return out;
}
