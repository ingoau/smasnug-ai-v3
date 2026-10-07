/**
 * What the agent module calls into (kept small and side-effect free on import): the end of a sandbox subagent's run.
 */
import { sql } from '../db/index.js';

/**
 * A sandbox subagent's run ended (any status): its sandbox starts its idle clock (the sweep pauses it after
 * limits.sandboxIdlePauseMs).
 */
export async function onSandboxRunFinished(runId: number): Promise<void> {
  const [run] = await sql<{ status: string; subagentId: string }[]>`select status, subagent_id from runs where id = ${runId}`;
  if (!run || run.status === 'queued' || run.status === 'running') return;
  await sql`update sandboxes set idle_since = now() where subagent_id = ${run.subagentId} and state = 'running'`;
}
