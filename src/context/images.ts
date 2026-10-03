/** Stable per-thread image ids (img_N) in `thread_images`, allocated from `threads.next_image_n`. */
import { sql } from '../db/index.js';
import type { SlackFileRef } from '../core/types.js';
import { isImageFile, type RenderMsg } from './format.js';

export interface ThreadImage {
  threadId: string;
  n: number;
  fileId: string;
  name: string | null;
  mimetype: string | null;
  urlPrivate: string | null;
  fromUser: string | null;
  messageTs: string | null;
}

interface ImageCandidate {
  file: SlackFileRef;
  fromUser: string | null;
  messageTs: string;
}

/**
 * Assign ids to every image in `msgs` (idempotent: existing files keep their number). Race-safe: the thread row is
 * locked `for update` while numbers are handed out, so concurrent workers can't hand out the same N twice.
 * The thread row must exist. Returns fileId → n for all images in `msgs`.
 */
export async function assignImageIds(threadId: string, msgs: RenderMsg[]): Promise<Map<string, number>> {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.deleted) continue;
    for (const f of m.files ?? []) {
      if (!f?.id || seen.has(f.id) || !isImageFile(f)) continue;
      seen.add(f.id);
      candidates.push({ file: f, fromUser: m.botId ? null : m.userId, messageTs: m.ts });
    }
  }
  const out = new Map<string, number>();
  if (!candidates.length) return out;
  const ids = candidates.map((c) => c.file.id);

  const existing = await sql<{ fileId: string; n: number }[]>`
    select file_id, n from thread_images where thread_id = ${threadId} and file_id in ${sql(ids)}`;
  for (const r of existing) out.set(r.fileId, r.n);
  const missing = candidates.filter((c) => !out.has(c.file.id));
  if (!missing.length) return out;

  await sql.begin(async (tx) => {
    const [thread] = await tx<{ nextImageN: number }[]>`select next_image_n from threads where id = ${threadId} for update`;
    if (!thread) throw new Error(`assignImageIds: thread ${threadId} does not exist`);
    // Re-read under the lock: another worker may have assigned some meanwhile.
    const again = await tx<{ fileId: string; n: number }[]>`
      select file_id, n from thread_images where thread_id = ${threadId} and file_id in ${tx(missing.map((c) => c.file.id))}`;
    for (const r of again) out.set(r.fileId, r.n);
    let next = thread.nextImageN;
    for (const c of missing) {
      if (out.has(c.file.id)) continue;
      const f = c.file as SlackFileRef & { url_private?: string };
      await tx`insert into thread_images (thread_id, n, file_id, name, mimetype, url_private, from_user, message_ts)
        values (${threadId}, ${next}, ${f.id}, ${f.name ?? null}, ${f.mimetype ?? null}, ${f.urlPrivate ?? f.url_private ?? null}, ${c.fromUser}, ${c.messageTs})`;
      out.set(f.id, next);
      next++;
    }
    await tx`update threads set next_image_n = ${next} where id = ${threadId}`;
  });
  return out;
}

/** Resolve `img_N` (or `N`) for a thread. Only images registered for THIS thread resolve. */
export async function getThreadImage(threadId: string, id: string): Promise<ThreadImage | null> {
  const m = /^(?:img_?)?(\d+)$/i.exec(id.trim());
  if (!m) return null;
  const [row] = await sql<ThreadImage[]>`select * from thread_images where thread_id = ${threadId} and n = ${Number(m[1])}`;
  return row ?? null;
}
