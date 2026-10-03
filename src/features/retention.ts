/**
 * Daily retention. Keep only what's needed: thread data, runs, subagent histories and usage go after ~30 days;
 * short-lived coordination rows after ~2 days. Per-user memory is the exception (expires by last_used).
 * sent_messages / reports are kept so reports keep their original sender.
 */
import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { expireFacts } from './memory/store.js';

export const SHORT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
export const IMAGE_CACHE_DIR = path.resolve(process.cwd(), '.cache/images');

const secs = (ms: number) => Math.floor(ms / 1000);

export async function runRetention(now = Date.now()): Promise<Record<string, number>> {
  const long = secs(limits.retentionMs);
  const short = secs(SHORT_RETENTION_MS);
  const counts: Record<string, number> = {};
  const run = async (name: string, q: PromiseLike<readonly unknown[]>) => {
    try {
      counts[name] = (await q).length;
    } catch (err) {
      log.error({ err, step: name }, 'retention step failed');
    }
  };
  const older = (s: number) => sql`now() - ${s} * interval '1 second'`;

  // Whole threads without recent activity (cascades to messages, events, turns, cards, subagents, runs, images…).
  await run(
    'threads',
    sql`delete from threads t where t.last_activity_at < ${older(long)}
        and not exists (select 1 from runs r where r.thread_id = t.id and r.status in ('queued', 'running'))
        returning t.id`,
  );
  // Old rows inside still-active threads.
  await run('thread_events', sql`delete from thread_events where created_at < ${older(long)} returning id`);
  await run('runs', sql`delete from runs where created_at < ${older(long)} and status not in ('queued', 'running') returning id`);
  await run(
    'subagents',
    sql`delete from subagents s where s.last_active_at < ${older(long)} and s.status <> 'running'
        and not exists (select 1 from runs r where r.subagent_id = s.id and r.status in ('queued', 'running'))
        returning s.id`,
  );
  await run('turns', sql`delete from turns where created_at < ${older(long)} and status not in ('pending', 'running') returning id`);
  await run('cards', sql`delete from cards where created_at < ${older(long)} returning id`);
  await run('messages', sql`delete from messages where created_at < ${older(long)} returning ts`);
  // Copies of messages deleted in Slack: drop the content right away.
  await run('messages_deleted_content', sql`update messages set text = '', files = '[]' where deleted and (text <> '' or files <> '[]') returning ts`);
  await run('usage', sql`delete from usage where created_at < ${older(long)} returning id`);

  await run('pending_sends', sql`delete from pending_sends where created_at < ${older(short)} returning id`);
  await run('idempotency_keys', sql`delete from idempotency_keys where created_at < ${older(short)} returning key`);
  await run('slack_events_seen', sql`delete from slack_events_seen where received_at < ${older(short)} returning event_id`);

  try {
    counts.user_memory = await expireFacts(limits.memoryFactExpiryMs);
  } catch (err) {
    log.error({ err }, 'memory expiry failed');
  }
  counts.image_files = await pruneDir(IMAGE_CACHE_DIR, now - limits.retentionMs);
  log.info({ counts }, 'retention done');
  return counts;
}

/** Delete files older than `cutoff` (mtime) under dir, recursively; remove emptied subdirectories. */
export async function pruneDir(dir: string, cutoff: number): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // doesn't exist
  }
  let n = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        n += await pruneDir(p, cutoff);
        if ((await readdir(p)).length === 0) await rmdir(p);
      } else if (e.isFile() && (await stat(p)).mtimeMs < cutoff) {
        await unlink(p);
        n++;
      }
    } catch (err) {
      log.warn({ err, path: p }, 'image cache prune failed');
    }
  }
  return n;
}
