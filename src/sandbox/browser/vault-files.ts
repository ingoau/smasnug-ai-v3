/**
 * Vault material in a sandbox lives only for the run that asked for it (docs/sandbox.md §3.9). Removed when the run
 * ends (hooks.ts) and before any pause snapshot (lifecycle.pauseSandbox; ModalProvider.pause always drops /work/.vault
 * and /work/.last):
 * - files (sandbox_use_credential → /work/.vault/<name>; sandbox_save_credential read a secret there);
 * - the browser's login (browser_load_session, browser_fill_credential): agent-browser is closed and its saved session
 *   (/work/.agent-browser: cookies + localStorage) deleted, so a later run, possibly steered by someone else, doesn't
 *   inherit the owner's logged-in browser without a new approval;
 * - either way /work/.last (full output of the last command, which may hold a secret).
 * A Redis flag per subagent and kind says there is something to remove, so ordinary runs cost no extra exec.
 * No tool registration here (hooks.ts and lifecycle.ts import it).
 */
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { BROWSER_STATE_DIR, LAST_OUTPUT_DIR, VAULT_DIR } from '../protected.js';
import { shq, type Handle } from '../provider.js';
import { sandboxProvider } from '../providers.js';

export { VAULT_DIR };

const FLAG_TTL_S = 26 * 3600;
const filesFlag = (subagentId: string) => `vault:sbxfiles:${subagentId}`;
const browserFlag = (subagentId: string) => `vault:sbxbrowser:${subagentId}`;

/** Vault files went into the sandbox (or a secret was read from it). */
export async function markVaultFiles(subagentId: string): Promise<void> {
  await redis.set(filesFlag(subagentId), '1', 'EX', FLAG_TTL_S);
}

/** The browser was logged in with vault material (a saved session loaded, a stored login typed). */
export async function markVaultBrowser(subagentId: string): Promise<void> {
  await redis.set(browserFlag(subagentId), '1', 'EX', FLAG_TTL_S);
}

export interface VaultFlags {
  files: boolean;
  browser: boolean;
}

export async function vaultFlags(subagentId: string): Promise<VaultFlags> {
  const [f, b] = await redis.mget(filesFlag(subagentId), browserFlag(subagentId)).catch(() => [null, null]);
  return { files: Boolean(f), browser: Boolean(b) };
}

/** Close the browser (it saves its session on close) and delete the saved session. */
export const CLEAR_BROWSER = `if compgen -G ${shq(`${BROWSER_STATE_DIR}/`)}'*.pid' >/dev/null; then timeout 10 agent-browser close --all >/dev/null 2>&1; fi; rm -rf -- ${shq(BROWSER_STATE_DIR)}`;

/** The cleanup for these flags (null: nothing to do). */
export function cleanupScript(f: VaultFlags): string | null {
  if (!f.files && !f.browser) return null;
  return [...(f.browser ? [CLEAR_BROWSER] : []), `rm -rf -- ${shq(VAULT_DIR)} ${shq(LAST_OUTPUT_DIR)}`].join('\n');
}

/**
 * Remove the subagent's vault material from its live sandbox(es), or from `handle` (a pause about to snapshot it).
 * Best effort: the flags stay set when it fails, so the next run end or pause tries again.
 */
export async function clearVaultMaterial(subagentId: string, handle?: Handle): Promise<void> {
  const flags = await vaultFlags(subagentId);
  const script = cleanupScript(flags);
  if (!script) return;
  const handles = handle
    ? [handle]
    : (await sql<{ providerId: string | null }[]>`select provider_id from sandboxes where subagent_id = ${subagentId} and state = 'running'`).filter((r) => r.providerId).map((r) => ({ providerId: r.providerId! }));
  let failed = false;
  for (const h of handles) {
    const r = await sandboxProvider()
      .exec(h, ['bash', '-c', script], { timeoutMs: 30_000, maxOutputBytes: 1024 })
      .catch((err) => {
        log.warn({ err, subagentId }, 'removing vault material from the sandbox failed (the next run end or pause retries)');
        return null;
      });
    if (!r || r.exitCode !== 0) failed = true;
  }
  if (!failed) await redis.del(filesFlag(subagentId), browserFlag(subagentId)).catch(() => {});
}
