/**
 * Vault files in a sandbox (sandbox_use_credential → /work/.vault/<name>) live only for the run that asked: removed
 * when the run ends (hooks.ts) and before any pause snapshot (ModalProvider.pause). A Redis flag per subagent says
 * there is something to remove, so ordinary runs cost no extra exec. No tool registration here (hooks.ts imports it).
 */
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { shq } from '../provider.js';
import { sandboxProvider } from '../providers.js';

export const VAULT_DIR = '/work/.vault';
const flag = (subagentId: string) => `vault:sbxfiles:${subagentId}`;

export async function markVaultFiles(subagentId: string): Promise<void> {
  await redis.set(flag(subagentId), '1', 'EX', 26 * 3600);
}

/** The bash that removes the vault directory (also what the fake provider recognises). */
export const RM_VAULT = `rm -rf -- ${shq(VAULT_DIR)}`;

/** Remove /work/.vault from the subagent's live sandbox, if it was given vault files. Best effort. */
export async function clearVaultFiles(subagentId: string): Promise<void> {
  if (!(await redis.get(flag(subagentId)).catch(() => null))) return;
  const rows = await sql<{ providerId: string | null }[]>`select provider_id from sandboxes where subagent_id = ${subagentId} and state = 'running'`;
  let failed = false;
  for (const r of rows) {
    if (!r.providerId) continue;
    await sandboxProvider()
      .exec({ providerId: r.providerId }, ['bash', '-c', RM_VAULT], { timeoutMs: 20_000, maxOutputBytes: 1024 })
      .catch((err) => {
        failed = true;
        log.warn({ err, subagentId }, 'removing vault files from the sandbox failed (the pause removes them)');
      });
  }
  if (!failed) await redis.del(flag(subagentId)).catch(() => {});
}
