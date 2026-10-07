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
import { log } from '../log.js';
import { compareTs, debounceWindowMs, type BatchReason } from './rules.js';

const batchKey = (threadId: string, authorId: string) => `debounce:batch:${threadId}:${authorId}`;
const seqKey = (threadId: string, authorId: string) => `debounce:seq:${threadId}:${authorId}`;
/** Authors with a batch opened in this thread (recently): where hasPendingHumanInput looks. */
const authorsKey = (threadId: string) => `debounce:authors:${threadId}`;
/** Set while a taken batch is being gated / scheduled (value: the batch's seq). */
const inflightKey = (threadId: string, authorId: string) => `debounce:inflight:${threadId}:${authorId}`;
const KEY_TTL_MS = 60 * 60 * 1000;

/** BullMQ custom job ids must not contain ':'. */
const jobIdFor = (threadId: string, authorId: string, seq: number) => `deb-${threadId.replaceAll(':', '_')}-${authorId}-${seq}`;

const ADD = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
local s = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('PEXPIRE', KEYS[3], ARGV[3])
return s`;

/** Takes the batch and, atomically with it, marks it in flight (gate / scheduling), so it is never invisible. */
const TAKE = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return false end
local h = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
if #h > 0 then redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[2]) end
return h`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export interface DebounceJob {
  threadId: string;
  authorId: string;
  seq: number;
}

/**
 * Precise windows. A delayed BullMQ job fires up to ~100ms late (Redis expires blocking BZPOPMIN timeouts on its
 * `hz` cron, 10/s by default) — a third of a 300ms window. Workers therefore also fire the window from an
 * in-process timer; the delayed job (scheduled LOCAL_BACKUP_MS later) stays as the crash-safe backup and is
 * removed once the local fire ran. Both paths go through processDebounce, and takeBatch is atomic per sequence, so
 * a window is only ever taken once. Off unless enabled (the worker does; unit/integration tests drive jobs by hand).
 */
const LOCAL_BACKUP_MS = 1500;
let localFire: ((job: DebounceJob) => Promise<void>) | null = null;
export function enableLocalDebounce(fire: (job: DebounceJob) => Promise<void>): void {
  localFire = fire;
}

export async function hasActiveRuns(threadId: string): Promise<boolean> {
  const [row] = await sql<{ active: boolean }[]>`
    select exists(select 1 from runs where thread_id = ${threadId} and status in ('queued', 'running')) as active`;
  return Boolean(row?.active);
}

/** Add a message to the author's batch and (re)start the window. Returns the window used. */
export async function addToBatch(threadId: string, authorId: string, ts: string, reason: BatchReason): Promise<number> {
  const seq = Number(await redis.eval(ADD, 3, batchKey(threadId, authorId), seqKey(threadId, authorId), authorsKey(threadId), ts, reason, KEY_TTL_MS, authorId));
  const delay = debounceWindowMs(await hasActiveRuns(threadId), { idleMs: limits.debounceIdleMs, busyMs: limits.debounceBusyMs, directMs: limits.debounceDirectMs }, reason);
  const data: DebounceJob = { threadId, authorId, seq };
  const jobId = jobIdFor(threadId, authorId, seq);
  const fire = localFire;
  await enqueue(QUEUE.turnDebounce, data, { delay: fire ? delay + LOCAL_BACKUP_MS : delay, jobId });
  if (fire) {
    setTimeout(() => {
      fire(data)
        .then(() => queue(QUEUE.turnDebounce).remove(jobId))
        .catch((err) => log.warn({ err, threadId }, 'local debounce fire failed; the delayed job will retry'));
    }, delay);
  }
  // Best effort: drop the superseded job so the delayed set doesn't fill with no-ops.
  if (seq > 1) await queue(QUEUE.turnDebounce).remove(jobIdFor(threadId, authorId, seq - 1)).catch(() => {});
  return delay;
}

/** True if `job` is still the latest window for its (thread, author), i.e. not superseded by a newer message. */
export async function isLatestSeq(job: DebounceJob): Promise<boolean> {
  return (await redis.get(seqKey(job.threadId, job.authorId))) === String(job.seq);
}

/** Deletion during the window removes the message; an emptied batch makes the pending job a no-op (= cancelled). */
export async function removeFromBatch(threadId: string, authorId: string, ts: string): Promise<boolean> {
  return (await redis.hdel(batchKey(threadId, authorId), ts)) === 1;
}

/**
 * Atomically take the batch if `seq` is still the latest. Returns null for superseded jobs or empty batches. A taken
 * batch stays marked in flight until releaseInflight (or limits.gateInflightTtlMs).
 */
export async function takeBatch(job: DebounceJob): Promise<{ ts: string; reason: BatchReason }[] | null> {
  const res = (await redis.eval(
    TAKE,
    3,
    batchKey(job.threadId, job.authorId),
    seqKey(job.threadId, job.authorId),
    inflightKey(job.threadId, job.authorId),
    String(job.seq),
    limits.gateInflightTtlMs,
  )) as string[] | null;
  if (!res || res.length === 0) return null;
  const out: { ts: string; reason: BatchReason }[] = [];
  for (let i = 0; i < res.length; i += 2) out.push({ ts: res[i]!, reason: res[i + 1] as BatchReason });
  return out.sort((a, b) => compareTs(a.ts, b.ts));
}

/** The batch taken by `job` is no longer in flight (gated and scheduled, or dropped). A newer batch's mark stays. */
export async function releaseInflight(job: DebounceJob): Promise<void> {
  await redis.eval(RELEASE, 1, inflightKey(job.threadId, job.authorId), String(job.seq));
}

/**
 * Whether a person's message in this thread is still on its way to a turn: in an open debounce batch, or taken and
 * at the relevance gate / being scheduled. Used to hold results / scheduled turns (src/pipeline/turn-hold.ts).
 */
export async function hasPendingHumanInput(threadId: string): Promise<boolean> {
  const authors = await redis.smembers(authorsKey(threadId));
  if (authors.length === 0) return false;
  const keys = authors.flatMap((a) => [batchKey(threadId, a), inflightKey(threadId, a)]);
  return (await redis.exists(...keys)) > 0;
}

/** Drop the author's open batch (native stop): the pending debounce job then finds nothing to take. */
export async function clearBatch(threadId: string, authorId: string): Promise<void> {
  await redis.del(batchKey(threadId, authorId));
}
