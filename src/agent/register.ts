// Module registration: importing this registers tools/actions. The worker wires processors and maintenance.
import type { Job } from 'bullmq';
import { QUEUE, type QueueName } from '../core/queues.js';
import { registerAction } from '../core/actions.js';
import { limits } from '../config.js';
import { log } from '../log.js';
import { processCardRender } from './cards.js';
import { STOP_ALL_ACTION } from './card-render.js';
import { processSubagentRun, shutdownRuns } from './child.js';
import { expireIdleSubagents, sweepStaleRuns } from './maintenance.js';
import { cancelCardRuns } from './subagents.js';
import './leave-thread.js';
import './tools.js';

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {
  [QUEUE.subagentRun]: async (job) => {
    await processSubagentRun(Number(job.data.runId));
  },
  [QUEUE.cardRender]: async (job) => {
    await processCardRender(Number(job.data.cardId));
  },
};

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'agent:sweep-stale-runs': {
    everyMs: Math.max(5_000, Math.floor(limits.staleHeartbeatMs / 3)),
    run: async () => {
      await sweepStaleRuns();
    },
  },
  'agent:expire-subagents': {
    everyMs: 10 * 60 * 1000,
    run: async () => {
      const n = await expireIdleSubagents();
      if (n) log.info({ n }, 'expired idle subagents');
    },
  },
};

/** "Stop all" on a plan card: cancel every active run on that card, then re-render (no ephemeral). */
registerAction(STOP_ALL_ACTION, async (ctx) => {
  const cardId = Number(ctx.value);
  if (!cardId) return;
  await cancelCardRuns(cardId, ctx.userId);
});

/** Called on SIGTERM before the worker exits: in-flight runs on this worker are marked errored, cards re-rendered. */
export async function onShutdown(): Promise<void> {
  try {
    await shutdownRuns();
  } catch (err) {
    log.error({ err }, 'agent shutdown failed');
  }
}
