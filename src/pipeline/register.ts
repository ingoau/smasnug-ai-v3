// Module registration: importing this registers tools/actions. The worker wires processors and maintenance.
import type { Job } from 'bullmq';
import { QUEUE, type QueueName } from '../core/queues.js';
import { registerAction } from '../core/actions.js';
import { REPLY_CHOICE_ACTION } from '../agent/reply-buttons.js';
import { handleReplyChoice } from './reply-choice.js';
import { handlePrivacyAgree, retryStaleReplays } from './consent.js';
import { PRIVACY_AGREE_ACTION, PRIVACY_READ_ACTION, handlePrivacyRead } from '../features/privacy.js';
import { processDebounce } from './fire.js';
import { enableLocalDebounce } from './debounce.js';
import { recoverOrphanedTurns } from './maintenance.js';
import { resumeExpiredSuspensions } from './agent-session.js';
import { processSlackEvent } from './slack-events.js';
import { processThreadRun, shutdownThreadRuns } from './thread-run.js';

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {
  [QUEUE.slackEvents]: processSlackEvent,
  [QUEUE.turnDebounce]: processDebounce,
  [QUEUE.threadRun]: processThreadRun,
};

/** Quick-reply buttons under bot replies: a press acts as the presser replying with the label. */
registerAction(REPLY_CHOICE_ACTION, handleReplyChoice);
/** Privacy policy prompt (consent.ts): agree (replays held messages) and read (modal; also on App Home). */
registerAction(PRIVACY_AGREE_ACTION, handlePrivacyAgree);
registerAction(PRIVACY_READ_ACTION, handlePrivacyRead);

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'pipeline:recover-turns': { everyMs: 30_000, run: recoverOrphanedTurns },
  'pipeline:resume-suspended': { everyMs: 15_000, run: resumeExpiredSuspensions },
  'pipeline:privacy-replay': { everyMs: 60_000, run: retryStaleReplays },
};

/** Worker start: fire debounce windows from precise in-process timers (delayed jobs remain the backup). */
export function onStart(): void {
  enableLocalDebounce((data) => processDebounce({ data, id: `local-${data.seq}` } as Job<typeof data>));
}

/** Called on SIGTERM before the worker exits. */
export async function onShutdown(): Promise<void> {
  await shutdownThreadRuns(Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000));
}
