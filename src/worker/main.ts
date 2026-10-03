// OWNER: pipeline module. Worker process entry: starts BullMQ workers for every queue.
import { Worker, type Job } from 'bullmq';
import '../tools/index.js';
import * as agent from '../agent/register.js';
import * as features from '../features/register.js';
import * as pipeline from '../pipeline/register.js';
import * as tools from '../tools/register.js';
import { closeQueues, queue, QUEUE, type QueueName } from '../core/queues.js';
import { bullConnection, redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { WORKER_ID } from './identity.js';

type Processor = (job: Job) => Promise<void>;
type Task = { everyMs: number; run: () => Promise<void> };

const modules = { pipeline, tools, agent, features } as const;

/** Jobs are I/O bound (Slack, Postgres, model calls), so concurrency can be high. */
const CONCURRENCY: Record<QueueName, number> = {
  [QUEUE.slackEvents]: 20,
  [QUEUE.turnDebounce]: 20,
  [QUEUE.threadRun]: 50,
  [QUEUE.subagentRun]: 50,
  [QUEUE.cardRender]: 20,
  [QUEUE.maintenance]: 4,
};

export function collectProcessors(): Map<QueueName, Processor> {
  const out = new Map<QueueName, Processor>();
  for (const [modName, mod] of Object.entries(modules)) {
    for (const [q, fn] of Object.entries(mod.processors) as [QueueName, Processor | undefined][]) {
      if (!fn) continue;
      if (q === QUEUE.maintenance) throw new Error(`${modName}: register maintenance tasks via \`maintenance\`, not a processor`);
      if (out.has(q)) throw new Error(`queue ${q} has processors in more than one module (${modName})`);
      out.set(q, fn);
    }
  }
  return out;
}

export function collectMaintenance(): Map<string, Task> {
  const out = new Map<string, Task>();
  for (const [modName, mod] of Object.entries(modules)) {
    for (const [name, task] of Object.entries(mod.maintenance)) {
      if (out.has(name)) throw new Error(`maintenance task ${name} registered twice (${modName})`);
      out.set(name, task);
    }
  }
  return out;
}

async function scheduleMaintenance(tasks: Map<string, Task>) {
  const q = queue(QUEUE.maintenance);
  for (const [name, task] of tasks) {
    await q.upsertJobScheduler(name, { every: task.everyMs }, { name, data: { task: name }, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }
  // Drop schedulers for tasks that no longer exist (renamed/removed in a deploy).
  for (const s of await q.getJobSchedulers(0, -1)) {
    const id = (s as any).key ?? (s as any).id;
    if (id && !tasks.has(id)) await q.removeJobScheduler(id);
  }
}

export async function startWorker() {
  const processors = collectProcessors();
  const tasks = collectMaintenance();
  await scheduleMaintenance(tasks);

  const workers: Worker[] = [];
  for (const name of Object.values(QUEUE)) {
    let fn: Processor | undefined;
    if (name === QUEUE.maintenance) {
      fn = async (job) => {
        const task = tasks.get(job.data?.task);
        if (!task) return log.warn({ task: job.data?.task }, 'unknown maintenance task');
        await task.run();
      };
    } else {
      fn = processors.get(name);
    }
    if (!fn) {
      log.warn({ queue: name }, 'no processor registered; not consuming this queue');
      continue;
    }
    const w = new Worker(name, fn, { connection: bullConnection(), concurrency: CONCURRENCY[name] });
    w.on('failed', (job, err) => log.error({ queue: name, jobId: job?.id, err }, 'job failed'));
    w.on('error', (err) => log.error({ queue: name, err }, 'worker error'));
    workers.push(w);
  }
  log.info({ workerId: WORKER_ID, queues: workers.map((w) => w.name), maintenance: [...tasks.keys()] }, 'worker started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker shutting down');
    const hardExit = setTimeout(() => {
      log.error('shutdown timed out; exiting');
      process.exit(1);
    }, Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000));
    hardExit.unref();
    try {
      // 1. Stop taking new jobs (don't wait for active ones here).
      await Promise.all(workers.map((w) => w.pause(true)));
      // 2. Modules clean up in-flight work (mark runs/turns errored, release locks).
      const results = await Promise.allSettled(Object.values(modules).map((m) => m.onShutdown()));
      results.forEach((r) => r.status === 'rejected' && log.error({ err: r.reason }, 'onShutdown failed'));
      // 3. Close workers; force after a short grace so stuck jobs can't hold the process.
      await Promise.race([
        Promise.all(workers.map((w) => w.close())),
        new Promise((r) => setTimeout(r, 5_000)).then(() => Promise.all(workers.map((w) => w.close(true)))),
      ]);
      await closeQueues();
      await redis.quit();
      await sql.end({ timeout: 5 });
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  return { workers, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err) => {
    log.error({ err }, 'worker failed to start');
    process.exit(1);
  });
}
