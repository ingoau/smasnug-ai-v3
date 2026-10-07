// OWNER: agent module. Shared upload helper (reply + send_message).
import { createHash } from 'node:crypto';
import { slackCall } from '../core/slack.js';
import { threadIdOf } from '../core/events.js';
import { createFile, FileError, fileStore, loadFileBytes, recordFilePosts, resolveFile } from '../files/store.js';
import { sanitizeFileName } from '../files/format.js';

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
        files.push({ fileId: f.id, filename: sanitizeFileName(f.name) });
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

const FAKE = () => process.env.SLACK_FAKE === '1';

async function bytesOf(f: OutgoingFile): Promise<Buffer> {
  if (f.fileId) {
    const meta = await fileStore.metadata(f.fileId);
    if (!meta) throw new Error(`file ${f.fileId} no longer exists`);
    return loadFileBytes(meta);
  }
  return Buffer.from(f.content ?? '', 'utf8');
}

/**
 * Upload files via files.getUploadURLExternal → POST to upload_url → files.completeUploadExternal into a
 * channel/thread. The complete call carries the idempotency key, so a retried turn never shares files twice.
 * Store files are recorded as posted (file_posts): the Slack copy maps back to the same id in context, and the file
 * becomes usable in that thread.
 */
export async function uploadFiles(opts: { channelId: string; threadTs?: string; files: OutgoingFile[]; idempotencyKey: string }): Promise<void> {
  if (opts.files.length === 0) return;
  const uploaded: { id: string; title: string; fileId?: string }[] = [];
  for (const f of opts.files) {
    const bytes = await bytesOf(f);
    const res = await slackCall<any>('files.getUploadURLExternal', { filename: f.filename, length: bytes.byteLength });
    if (!res.upload_url || !res.file_id) throw new Error('files.getUploadURLExternal returned no upload_url');
    if (!FAKE()) {
      const up = await fetch(res.upload_url, {
        method: 'POST',
        body: new Uint8Array(bytes),
        headers: { 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!up.ok) throw new Error(`file upload failed: HTTP ${up.status}`);
    }
    uploaded.push({ id: res.file_id, title: f.filename, ...(f.fileId ? { fileId: f.fileId } : {}) });
  }
  const done = await slackCall<any>(
    'files.completeUploadExternal',
    { files: uploaded.map(({ id, title }) => ({ id, title })), channel_id: opts.channelId, ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}) },
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
