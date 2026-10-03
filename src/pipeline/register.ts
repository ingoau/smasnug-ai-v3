// Module registration: importing this registers tools/actions. The worker wires processors and maintenance.
import type { Job } from 'bullmq';
import { QUEUE, type QueueName } from '../core/queues.js';
import { registerAction } from '../core/actions.js';
import { REPLY_CHOICE_ACTION } from '../agent/reply-buttons.js';
import { handleReplyChoice } from './reply-choice.js';
import { processDebounce } from './fire.js';
import { enableLocalDebounce } from './debounce.js';
import { recoverOrphanedTurns } from './maintenance.js';
import { processSlackEvent } from './slack-events.js';
import { processThreadRun, shutdownThreadRuns } from './thread-run.js';

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {
  [QUEUE.slackEvents]: processSlackEvent,
  [QUEUE.turnDebounce]: processDebounce,
  [QUEUE.threadRun]: processThreadRun,
};

/** Quick-reply buttons under bot replies: a press acts as the presser replying with the label. */
registerAction(REPLY_CHOICE_ACTION, handleReplyChoice);

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'pipeline:recover-turns': { everyMs: 30_000, run: recoverOrphanedTurns },
};

/** Worker start: fire debounce windows from precise in-process timers (delayed jobs remain the backup). */
export function onStart(): void {
  enableLocalDebounce((data) => processDebounce({ data, id: `local-${data.seq}` } as Job<typeof data>));
}

/** Called on SIGTERM before the worker exits. */
export async function onShutdown(): Promise<void> {
  await shutdownThreadRuns(Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000));
}
