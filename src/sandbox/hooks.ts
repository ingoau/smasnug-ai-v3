/**
 * What the agent module calls into (kept small and side-effect free on import): the end of a sandbox subagent's run.
 */
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { onRunFinishedPreview } from './preview/flow.js';
import { previewsConfigured } from './settings.js';
import { enqueueRunEndPause } from './lifecycle.js';
import { clearVaultFiles } from './browser/vault-files.js';

/**
 * A sandbox subagent's run ended (any status): its sandbox starts its idle clock and, unless another run of the
 * subagent is queued or running, is paused after a short grace (limits.sandboxRunEndPauseMs, a delayed pause job)
 * rather than after the sweep's limits.sandboxIdlePauseMs, so idle live time isn't charged to the user's daily
 * minutes and the budget. Vault files the run was given (/work/.vault) are removed now. A requested preview is deployed (complete run) or dropped (anything else).
 */
export async function onSandboxRunFinished(runId: number): Promise<void> {
  const [run] = await sql<{ status: string; subagentId: string }[]>`select status, subagent_id from runs where id = ${runId}`;
  if (!run || run.status === 'queued' || run.status === 'running') return;
  const idle = await sql<{ id: string; generation: number }[]>`
    update sandboxes set idle_since = now() where subagent_id = ${run.subagentId} and state = 'running' returning id, generation`;
  const [next] = await sql<{ status: string }[]>`select status from runs where subagent_id = ${run.subagentId} and status in ('queued', 'running') order by status = 'running' desc limit 1`;
  // Vault files (/work/.vault) only live for the run that asked for them (a later run asks again).
  if (next?.status !== 'running') await clearVaultFiles(run.subagentId).catch((err) => log.warn({ err, runId }, 'vault file cleanup failed'));
  if (!next) {
    for (const sbx of idle) {
      await enqueueRunEndPause(sbx, runId).catch((err) => log.warn({ err, runId, sandboxId: sbx.id }, 'run-end pause enqueue failed (the sweep pauses it later)'));
    }
  }
  if (previewsConfigured()) await onRunFinishedPreview(runId, run.status).catch((err) => log.warn({ err, runId }, 'preview hand-off failed'));
}
