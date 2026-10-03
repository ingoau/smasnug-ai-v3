/** Pipeline maintenance: recover turns orphaned by crashes, prune dedupe rows. */
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { isLocked, threadLockKey } from './lock.js';
import { ensureThreadRun } from './scheduler.js';

/**
 * Threads with pending turns, or turns marked running, but nobody holding the thread lock: a worker crashed or an
 * enqueue was lost. Enqueue a thread-run; its holder marks stale running turns as errored and drains the rest.
 */
export async function recoverOrphanedTurns() {
  const rows = await sql<{ threadId: string }[]>`
    select distinct thread_id from turns
    where (status = 'pending' and created_at < now() - interval '30 seconds')
       or (status = 'running' and started_at < now() - interval '2 minutes')`;
  for (const { threadId } of rows) {
    if (await isLocked(threadLockKey(threadId))) continue;
    log.warn({ threadId }, 'recovering orphaned turns');
    await ensureThreadRun(threadId);
  }
}

export async function pruneSeenEvents() {
  await sql`delete from slack_events_seen where received_at < now() - interval '1 day'`;
}
