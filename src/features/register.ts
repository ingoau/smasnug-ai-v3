// Module registration: importing this registers tools/actions/App Home. The worker wires processors and maintenance.
import type { Job } from 'bullmq';
import { registerAction, registerAppHome } from '../core/actions.js';
import { QUEUE, type QueueName } from '../core/queues.js';
import { handleBotReportModAction, registerReportUserTool } from './bot-reports.js';
import { handleAdminAction, handleMemoryAction, publishHome } from './home.js';
import { handleSlash } from './killswitch.js';
import { runMemoryExtraction } from './memory/extract.js';
import { registerMemoryTools } from './memory/tools.js';
import { handleModAction, handleReport } from './reports.js';
import { runRetention } from './retention.js';
import { expirePendingSends, handleSendCancel, handleSendConfirm, registerSendTool } from './send/send.js';
import { handleFactAction } from './workspace.js';
import { registerScheduleTools, scheduleMaintenance } from './schedule/register.js';
import { handleScheduleAction } from './schedule/home.js';
import { djMaintenance, processHuddleFm, registerDjTools } from './huddlefm/register.js';

// Tools (front agent only): remember, forget, propose_workspace_fact, send_message, report_user
registerMemoryTools();
registerSendTool();
registerReportUserTool();
// Reminders and watches: set_reminder, list_reminders, cancel_reminder, create_watch, list_watches, cancel_watch
registerScheduleTools();
// HuddleFM DJ mode (only when HUDDLEFM_USER_ID is set): huddle_dj_mode, huddle_dj, huddle_dj_settings
registerDjTools();

// Interactions
registerAction('send:confirm', handleSendConfirm);
registerAction('send:cancel', handleSendCancel);
registerAction('report:open', handleReport);
// Bot-report moderation actions: registered before the generic 'mod:' prefix (first matching prefix wins).
registerAction('mod:suspend', (ctx) => handleBotReportModAction(ctx, publishHome));
registerAction('mod:review_bot_report', (ctx) => handleBotReportModAction(ctx, publishHome));
registerAction('mod:dismiss_bot_report', (ctx) => handleBotReportModAction(ctx, publishHome));
registerAction('mod:', (ctx) => handleModAction(ctx, publishHome));
registerAction('fact:', (ctx) => handleFactAction(ctx, publishHome));
registerAction('mem:', handleMemoryAction);
registerAction('admin:', handleAdminAction);
registerAction('slash:/smasnug', handleSlash);
registerAction('sched:', (ctx) => handleScheduleAction(ctx, publishHome));
registerAppHome(publishHome);

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {
  [QUEUE.huddlefm]: processHuddleFm,
};

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'features:memory-extraction': { everyMs: 5 * 60 * 1000, run: runMemoryExtraction },
  'features:pending-send-expiry': { everyMs: 60 * 1000, run: expirePendingSends },
  'features:retention': { everyMs: 24 * 60 * 60 * 1000, run: async () => void (await runRetention()) },
  ...scheduleMaintenance,
  ...djMaintenance,
};

/** Called on SIGTERM before the worker exits. */
export async function onShutdown(): Promise<void> {}
