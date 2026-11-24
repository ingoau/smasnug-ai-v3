// OWNER: agent module. Shared upload helpers (reply + send_message).
import { createHash } from 'node:crypto';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';
import { threadIdOf, threadTsArg } from '../core/events.js';
import { createFile, FileError, fileStore, loadFileBytes, recordFilePosts, resolveFile, type FileMeta } from '../files/store.js';
import { sanitizeFileName, slackSnippetType, uploadContentType } from '../files/format.js';
import { copyLargeFileTo, transferTimeoutMs } from '../files/large.js';
import { urlImage } from './rich-blocks.js';
import type { ImageArg } from './reply.js';

/**
 * A file to post: a file-store file (`fileId`; access already checked by `prepareOutgoingFiles`), or inline text
 * (`content`; only pending sends created before the file store still carry it).
 */
export interface OutgoingFile {
  filename: string;
  fileId?: string;
  content?: string;
}

/** What the model may pass in `files`: a file id, or an inline text file (stored as a created file first). */
export type FileArg = string | { filename: string; content: string; description?: string };

/**
 * Turn the model's `files` into postable store files: ids are checked against the access rule (current thread, or
 * the speaker's own files); inline `{filename, content}` become created files owned by the speaker. Problems come
 * back as model-facing notes; the rest still goes out.
 */
export async function prepareOutgoingFiles(
  ctx: { threadId: string; speakerId: string; turnId?: number | null },
  items: readonly FileArg[] | undefined,
): Promise<{ files: OutgoingFile[]; errors: string[] }> {
  const files: OutgoingFile[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of items ?? []) {
    if (typeof item === 'string') {
      const f = await resolveFile(item, ctx);
      if ('error' in f) errors.push(f.error);
      else if (!seen.has(f.id)) {
        seen.add(f.id);
        const problem = await notDownloadable(f);
        if (problem) errors.push(problem);
        else files.push({ fileId: f.id, filename: sanitizeFileName(f.name) });
      }
      continue;
    }
    if (!item || typeof item.content !== 'string') continue;
    try {
      const bytes = Buffer.from(item.content, 'utf8');
      const key = createHash('sha256').update(item.filename ?? '').update('\0').update(bytes).digest('hex').slice(0, 32);
      const f = await createFile({
        threadId: ctx.threadId,
        ownerId: ctx.speakerId,
        name: item.filename,
        content: bytes,
        description: item.description ?? '',
        createdTurnId: ctx.turnId ?? null,
        ...(ctx.turnId ? { idempotencyKey: `turn:${ctx.turnId}:${key}` } : {}),
      });
      if (!seen.has(f.id)) {
        seen.add(f.id);
        files.push({ fileId: f.id, filename: f.name });
      }
    } catch (err) {
      errors.push(err instanceof FileError ? `${item.filename}: ${err.message}` : `${item.filename}: could not be stored`);
    }
  }
  return { files, errors };
}

/**
 * An upload not fetched yet is fetched now (and kept, like any first use), so a file Slack won't let the bot download
 * (e.g. in a channel the bot isn't in, without a user token that may read files) is reported per file before the
 * message goes out, instead of failing the whole upload after the text is already visible. Null: it can be posted.
 */
async function notDownloadable(f: FileMeta): Promise<string | null> {
  if (f.origin !== 'upload' || f.hasContent || f.blobSlackFileId) return null;
  try {
    await loadFileBytes(f);
    return null;
  } catch (err) {
    log.info({ err, fileId: f.id }, 'file to post could not be downloaded');
    return `${f.id} (${f.name}) couldn't be attached: ${err instanceof FileError ? err.message : 'downloading it from Slack failed'}.`;
  }
}

/** Image types Slack's image block shows (`slack_file`: png, jpg, jpeg, gif). */
const BLOCK_IMAGE = /^image\/(png|jpeg|gif)$/i;
const BLOCK_IMAGE_NAME = /\.(png|jpe?g|gif)$/i;

/** What the model may pass in `images`. */
export interface ImageInput {
  file?: string;
  url?: string;
  alt?: unknown;
  title?: unknown;
}

/**
 * The model's `images` → inputs for the reply (numbered as listed, so `[[image:n]]` keeps pointing at the same one):
 * file ids are access-checked like `files`; an image type the block can't show (webp, heic, …) is attached as a file
 * instead. Problems come back as model-facing notes.
 */
export async function prepareImageArgs(
  ctx: { threadId: string; speakerId: string },
  items: readonly ImageInput[] | null | undefined,
  max: number,
): Promise<{ images: ImageArg[]; attach: OutgoingFile[]; errors: string[] }> {
  const images: ImageArg[] = [];
  const attach: OutgoingFile[] = [];
  const errors: string[] = [];
  const list = items ?? [];
  if (list.length > max) errors.push(`Only the first ${max} images were shown.`);
  for (const [i, item] of list.slice(0, max).entries()) {
    const n = i + 1;
    const alt = typeof item?.alt === 'string' ? item.alt : '';
    const title = typeof item?.title === 'string' && item.title.trim() ? item.title : undefined;
    if (item?.file) {
      const f = await resolveFile(item.file, ctx);
      if ('error' in f) {
        errors.push(f.error);
        continue;
      }
      const problem = await notDownloadable(f);
      if (problem) {
        errors.push(problem);
        continue;
      }
      const file = { fileId: f.id, filename: sanitizeFileName(f.name) };
      if (!(f.mime ? BLOCK_IMAGE.test(f.mime) : BLOCK_IMAGE_NAME.test(f.name))) {
        attach.push(file);
        errors.push(`${f.id} (${f.name}) is not a PNG, JPEG or GIF, so it was attached as a file instead of shown inline.`);
        continue;
      }
      images.push({ n, file, alt: alt || f.description || f.name, ...(title ? { title } : {}) });
    } else if (item?.url) {
      const u = urlImage(item);
      if (typeof u === 'string') errors.push(u);
      else images.push({ n, url: u.url!, alt: u.alt || 'image', ...(u.title ? { title: u.title } : {}) });
    } else errors.push(`Dropped image ${n}: it needs a file id or a url.`);
  }
  return { images, attach, errors };
}

const FAKE = () => process.env.SLACK_FAKE === '1';

/** The bytes to upload, or a large file (src/files/large.ts), which is copied from its Slack copy instead. */
async function sourceOf(f: OutgoingFile): Promise<{ bytes: Buffer } | { large: FileMeta & { size: number } }> {
  if (f.fileId) {
    const meta = await fileStore.metadata(f.fileId);
    if (!meta) throw new Error(`file ${f.fileId} no longer exists`);
    if (meta.blobSlackFileId && meta.size != null) return { large: { ...meta, size: meta.size } };
    return { bytes: await loadFileBytes(meta) };
  }
  return { bytes: Buffer.from(f.content ?? '', 'utf8') };
}

/**
 * files.getUploadURLExternal with the file's Slack type as `snippet_type` (an .html file was shown as plain text
 * without it; completeUploadExternal takes no type). Slack refusing the type (`unknown_snippet_type`) → retried without.
 */
async function getUploadUrl(filename: string, length: number): Promise<any> {
  const snippetType = slackSnippetType(filename, length);
  try {
    return await slackCall<any>('files.getUploadURLExternal', { filename, length, ...(snippetType ? { snippet_type: snippetType } : {}) });
  } catch (err) {
    if (!snippetType || slackErrorCode(err) !== 'unknown_snippet_type') throw err;
    log.info({ snippetType }, 'Slack refused the snippet type; uploading without it');
    return slackCall<any>('files.getUploadURLExternal', { filename, length });
  }
}

/**
 * Upload files via files.getUploadURLExternal → POST to upload_url → files.completeUploadExternal into a
 * channel/thread. The complete call carries the idempotency key, so a retried turn never shares files twice.
 * Store files are recorded as posted (file_posts): the Slack copy maps back to the same id in context, and the file
 * becomes usable in that thread.
 */
/** Steps 1–2 of an upload (get URL, POST the bytes), per file. */
async function sendBytes(files: OutgoingFile[]): Promise<{ id: string; title: string; fileId?: string }[]> {
  const uploaded: { id: string; title: string; fileId?: string }[] = [];
  for (const f of files) {
    const src = await sourceOf(f);
    if ('large' in src) {
      const res = await slackCall<any>('files.getUploadURLExternal', { filename: f.filename, length: src.large.size });
      if (!res.upload_url || !res.file_id) throw new Error('files.getUploadURLExternal returned no upload_url');
      await copyLargeFileTo(src.large, res.upload_url, uploadContentType(f.filename));
      uploaded.push({ id: res.file_id, title: f.filename, fileId: src.large.id });
      continue;
    }
    const { bytes } = src;
    const res = await getUploadUrl(f.filename, bytes.byteLength);
    if (!res.upload_url || !res.file_id) throw new Error('files.getUploadURLExternal returned no upload_url');
    if (!FAKE()) {
      const up = await fetch(res.upload_url, {
        method: 'POST',
        body: new Uint8Array(bytes),
        headers: { 'content-type': uploadContentType(f.filename) },
        // Store files go up to limits.fileMaxBytes: a fixed 30 s cut off big ones on a slow link.
        signal: AbortSignal.timeout(transferTimeoutMs(bytes.byteLength)),
      });
      if (!up.ok) throw new Error(`file upload failed: HTTP ${up.status}`);
    }
    uploaded.push({ id: res.file_id, title: f.filename, ...(f.fileId ? { fileId: f.fileId } : {}) });
  }
  return uploaded;
}

/**
 * Upload files to Slack without sharing them anywhere (files.completeUploadExternal without a channel): for image
 * blocks (`slack_file`) and for attaching to an existing message (chat.update `file_ids`). In input order. The
 * complete call carries the idempotency key (a retried turn reuses the first attempt's files).
 */
export async function uploadPrivateFiles(files: OutgoingFile[], idempotencyKey: string): Promise<{ slackFileId: string; fileId?: string; filename: string }[]> {
  if (files.length === 0) return [];
  const uploaded = await sendBytes(files);
  const done = await slackCall<any>('files.completeUploadExternal', { files: uploaded.map(({ id, title }) => ({ id, title })) }, { idempotencyKey });
  const ids: string[] = Array.isArray(done?.files) ? done.files.map((x: any) => x?.id).filter(Boolean) : [];
  return uploaded.map((u, i) => ({ slackFileId: ids[i] ?? u.id, filename: u.title, ...(u.fileId ? { fileId: u.fileId } : {}) }));
}

export async function uploadFiles(opts: { channelId: string; threadTs?: string; files: OutgoingFile[]; idempotencyKey: string }): Promise<void> {
  if (opts.files.length === 0) return;
  const uploaded = await sendBytes(opts.files);
  const done = await slackCall<any>(
    'files.completeUploadExternal',
    { files: uploaded.map(({ id, title }) => ({ id, title })), channel_id: opts.channelId, ...threadTsArg(opts.threadTs) },
    { idempotencyKey: opts.idempotencyKey },
  );
  // A replayed (idempotent) completion shared the files of the first attempt: map those, not this attempt's ids.
  const sharedIds: string[] = Array.isArray(done?.files) ? done.files.map((x: any) => x?.id).filter(Boolean) : uploaded.map((u) => u.id);
  const threadId = threadIdOf(opts.channelId, opts.threadTs ?? '');
  const posts = uploaded
    .map((u, i) => ({ fileId: u.fileId, slackFileId: sharedIds[i] ?? u.id, channelId: opts.channelId, threadId }))
    .filter((p): p is { fileId: string; slackFileId: string; channelId: string; threadId: string } => !!p.fileId && !!opts.threadTs);
  await recordFilePosts(posts);
}
