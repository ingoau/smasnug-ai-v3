/**
 * Debounce per (thread, author). Batch state lives in Redis (hash ts -> reason) with a sequence counter; every
 * message enqueues a delayed `turn-debounce` job carrying the sequence it saw. When a job fires it takes the batch
 * only if no newer message arrived since (sequence unchanged) — newer messages have their own, later job. All
 * batch mutations are single Lua scripts, so this is safe with any number of workers.
 */
import { redis } from '../core/redis.js';
import { enqueue, queue, QUEUE } from '../core/queues.js';
import { sql } from '../db/index.js';
import { limits } from '../config.js';
import { compareTs, debounceWindowMs, type BatchReason } from './rules.js';

const batchKey = (threadId: string, authorId: string) => `debounce:batch:${threadId}:${authorId}`;
const seqKey = (threadId: string, authorId: string) => `debounce:seq:${threadId}:${authorId}`;
const KEY_TTL_MS = 60 * 60 * 1000;

/** BullMQ custom job ids must not contain ':'. */
const jobIdFor = (threadId: string, authorId: string, seq: number) => `deb-${threadId.replaceAll(':', '_')}-${authorId}-${seq}`;

const ADD = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
local s = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return s`;

const TAKE = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return false end
local h = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return h`;

export interface DebounceJob {
  threadId: string;
  authorId: string;
  seq: number;
}

export async function hasActiveRuns(threadId: string): Promise<boolean> {
  const [row] = await sql<{ active: boolean }[]>`
    select exists(select 1 from runs where thread_id = ${threadId} and status in ('queued', 'running')) as active`;
  return Boolean(row?.active);
}

/** Add a message to the author's batch and (re)start the window. Returns the window used. */
export async function addToBatch(threadId: string, authorId: string, ts: string, reason: BatchReason): Promise<number> {
  const seq = Number(await redis.eval(ADD, 2, batchKey(threadId, authorId), seqKey(threadId, authorId), ts, reason, KEY_TTL_MS));
  const delay = debounceWindowMs(await hasActiveRuns(threadId), { idleMs: limits.debounceIdleMs, busyMs: limits.debounceBusyMs });
  await enqueue(QUEUE.turnDebounce, { threadId, authorId, seq } satisfies DebounceJob, { delay, jobId: jobIdFor(threadId, authorId, seq) });
  // Best effort: drop the superseded job so the delayed set doesn't fill with no-ops.
  if (seq > 1) await queue(QUEUE.turnDebounce).remove(jobIdFor(threadId, authorId, seq - 1)).catch(() => {});
  return delay;
}

/** Deletion during the window removes the message; an emptied batch makes the pending job a no-op (= cancelled). */
export async function removeFromBatch(threadId: string, authorId: string, ts: string): Promise<boolean> {
  return (await redis.hdel(batchKey(threadId, authorId), ts)) === 1;
}

/** Atomically take the batch if `seq` is still the latest. Returns null for superseded jobs or empty batches. */
export async function takeBatch(job: DebounceJob): Promise<{ ts: string; reason: BatchReason }[] | null> {
  const res = (await redis.eval(TAKE, 2, batchKey(job.threadId, job.authorId), seqKey(job.threadId, job.authorId), String(job.seq))) as string[] | null;
  if (!res || res.length === 0) return null;
  const out: { ts: string; reason: BatchReason }[] = [];
  for (let i = 0; i < res.length; i += 2) out.push({ ts: res[i]!, reason: res[i + 1] as BatchReason });
  return out.sort((a, b) => compareTs(a.ts, b.ts));
}

/** Drop the author's open batch (native stop): the pending debounce job then finds nothing to take. */
export async function clearBatch(threadId: string, authorId: string): Promise<void> {
  await redis.del(batchKey(threadId, authorId));
}
