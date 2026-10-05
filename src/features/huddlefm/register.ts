/** HuddleFM DJ mode: front-agent tools, the `huddlefm` queue processor and the sweep (wired from src/features/register.ts). */
import type { Job } from 'bullmq';
import { registerTool } from '../../core/tools.js';
import { processDjSync, sweepSessions, type DjSyncJob } from './autodj.js';
import { huddleFmConfigured } from './client.js';
import { DJ_TOOL_NAMES, djTools } from './tools.js';

/** Tools only exist when HuddleFM is configured (HUDDLEFM_USER_ID). */
export function registerDjTools(): void {
  if (!huddleFmConfigured()) return;
  for (const name of DJ_TOOL_NAMES) registerTool({ name, roles: ['front'], build: (ctx) => djTools(ctx)[name] });
}

export async function processHuddleFm(job: Job<DjSyncJob>): Promise<void> {
  if (!huddleFmConfigured()) return;
  await processDjSync(job);
}

export const djMaintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'features:huddlefm-sweep': { everyMs: 60_000, run: async () => (huddleFmConfigured() ? sweepSessions() : undefined) },
};
