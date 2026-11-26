/**
 * Paths in a sandbox that hold secrets or copies of them (docs/sandbox.md §3.9). Pure; protected.test.ts.
 * - /work/.vault: credentials from the owner's vault (sandbox_use_credential).
 * - /work/.agent-browser: agent-browser's saved default session (cookies + localStorage, plaintext; HOME=/work),
 *   which holds logins from the vault (browser_load_session, browser_fill_credential).
 * - /work/.last: the full stdout / stderr of the last sandbox_exec (format.ts), which can hold secrets.
 * They never leave the sandbox as files: sandbox_export, request_preview and browser_open (file://) refuse them, also
 * through a symlink or a hard link (checked in the sandbox). sandbox_read_file refuses the first two (its text output is
 * scrubbed, but cookies aren't vault secrets) and may show /work/.last (scrubbed like any command output).
 */
import { shq } from './provider.js';

export const VAULT_DIR = '/work/.vault';
export const BROWSER_STATE_DIR = '/work/.agent-browser';
export const LAST_OUTPUT_DIR = '/work/.last';
export const PROTECTED_DIRS = [VAULT_DIR, BROWSER_STATE_DIR, LAST_OUTPUT_DIR] as const;
export type ProtectedDir = (typeof PROTECTED_DIRS)[number];

/** The protected directory a normalised absolute path (workPath) is, or is inside of; null if none. */
export function protectedDir(abs: string, dirs: readonly ProtectedDir[] = PROTECTED_DIRS): ProtectedDir | null {
  for (const d of dirs) if (abs === d || abs.startsWith(`${d}/`)) return d;
  return null;
}

/** The model-facing refusal for a protected path. */
export function protectedRefusal(dir: ProtectedDir): string {
  if (dir === VAULT_DIR) return `${VAULT_DIR} holds credentials from the owner's vault: reference the files in commands (e.g. "$(cat ${VAULT_DIR}/name)"), never read, print or export them.`;
  if (dir === BROWSER_STATE_DIR) return `${BROWSER_STATE_DIR} holds the browser's cookies and site storage (logins): it is never read, exported, published or opened.`;
  return `${LAST_OUTPUT_DIR} holds raw command output (it can contain secrets), so it can't be exported, published or opened in the browser. Write what you need to a file of its own.`;
}

/** Stdout marker the in-sandbox check prints when it refuses. */
export const PROTECTED_MARKER = 'PROTECTED_PATH';

/**
 * Bash that resolves `pathExpr` (symlinks; a quoted path or "$VAR") and, if it is a protected path or a hard link to a
 * file in one, prints PROTECTED_MARKER and exits 3. Otherwise it falls through.
 */
export function protectedCheckBash(pathExpr: string, dirs: readonly ProtectedDir[] = PROTECTED_DIRS): string {
  const pats = dirs.flatMap((d) => [shq(d), `${shq(d)}/*`]).join('|');
  return [
    `__r=$(realpath -m -- ${pathExpr} 2>/dev/null)`,
    `case "$__r" in ${pats}) echo ${PROTECTED_MARKER}; exit 3;; esac`,
    `if [ -f "$__r" ] && [ -n "$(find ${dirs.map(shq).join(' ')} -xdev -samefile "$__r" 2>/dev/null | head -n 1)" ]; then echo ${PROTECTED_MARKER}; exit 3; fi`,
  ].join('\n');
}
