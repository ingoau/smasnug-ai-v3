/**
 * BullMQ queues. Ingress only ever enqueues `slack-events`; everything else runs in workers.
 * Workers hold no per-thread state in memory: any worker can take any job.
 */
import { Queue, type JobsOptions } from 'bullmq';
import { bullConnection } from './redis.js';

export const QUEUE = {
  /** Raw Slack envelopes from ingress: { kind: 'event' | 'interactive' | 'slash', body } */
  slackEvents: 'slack-events',
  /** Delayed per (thread, author) debounce jobs: { threadId, authorId } */
  turnDebounce: 'turn-debounce',
  /** Drain a thread's pending turns under the thread lock: { threadId } */
  threadRun: 'thread-run',
  /** Execute one subagent run: { runId } */
  subagentRun: 'subagent-run',
  /** Coalesced plan-card re-render: { cardId } */
  cardRender: 'card-render',
  /**
   * HuddleFM DJ mode (src/features/huddlefm): status sync + auto DJ top-up per huddle channel: { channelId, reason }.
   * Its own queue: these jobs wait on HuddleFM replies that arrive through slack-events.
   */
  huddlefm: 'huddlefm',
  /** Rolling thread summary update (src/context/summary.ts): { threadId, targetTs }. Never blocks a turn. */
  threadSummary: 'thread-summary',
  /**
   * Code sandboxes (src/sandbox/): pause / destroy a sandbox, prepare / deploy a live preview:
   * { type: 'pause' | 'destroy', sandboxId, generation?, force? } | { type: 'preview-prepare' | 'preview-deploy', previewId }.
   */
  sandbox: 'sandbox',
  /** Repeatable maintenance: sweeper, expiry, memory extraction, retention */
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

const queues = new Map<string, Queue>();
export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: bullConnection(),
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    });
    queues.set(name, q);
  }
  return q;
}

export function enqueue(name: QueueName, data: unknown, opts?: JobsOptions) {
  return queue(name).add(name, data, opts);
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
}
