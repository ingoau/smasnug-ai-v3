/** Reminders + watches: front-agent tools and maintenance tasks (wired from src/features/register.ts). */
import { limits } from '../../config.js';
import { registerTool } from '../../core/tools.js';
import { fireDueReminders, reminderTools } from './reminders.js';
import { runDueWatchChecks, watchTools } from './watches.js';

export const SCHEDULE_TOOLS = ['set_reminder', 'list_reminders', 'cancel_reminder', 'create_watch', 'list_watches', 'cancel_watch'] as const;

export function registerScheduleTools() {
  for (const name of ['set_reminder', 'list_reminders', 'cancel_reminder'] as const)
    registerTool({ name, roles: ['front'], build: (ctx) => reminderTools(ctx)[name] });
  for (const name of ['create_watch', 'list_watches', 'cancel_watch'] as const)
    registerTool({ name, roles: ['front'], build: (ctx) => watchTools(ctx)[name] });
}

/** Maintenance tasks: reminders are polled every minute (~1 min precision); watch checks every few minutes. */
export const scheduleMaintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'features:reminders': { everyMs: limits.scheduleTickMs, run: async () => void (await fireDueReminders()) },
  'features:watch-checks': { everyMs: 5 * 60_000, run: async () => void (await runDueWatchChecks()) },
};
