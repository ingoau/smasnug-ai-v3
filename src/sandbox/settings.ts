/**
 * Sandbox kill switches (docs/sandbox.md §4.4): keys in the shared `settings` table, cached in-process for a few
 * seconds (like the guard's state), toggled from the App Home admin section.
 */
import { env } from '../config.js';
import { sql } from '../db/index.js';
import { setSetting } from '../features/state.js';

const CACHE_TTL_MS = 3000;

/** The sandbox tools (registered in tools.ts); child.ts drops them for subagents without `sandbox: true`. */
export const SANDBOX_TOOL_NAMES = ['sandbox_exec', 'sandbox_read_file', 'sandbox_write_file', 'sandbox_import', 'sandbox_export', 'request_preview'] as const;

export type AccessMode = 'hca_or_allowlist' | 'allowlist_only';

export interface SandboxSettings {
  /** The whole feature is off (running sandboxes get paused). The admin bypasses it. */
  disabled: boolean;
  /** No new preview deploys; live ones stay up until expiry unless taken down. */
  previewsDisabled: boolean;
  /** `allowlist_only` is the gating kill switch: HCA is not consulted, access fails closed to the allowlist. */
  accessMode: AccessMode;
}

export const SETTING_KEYS = {
  disabled: 'sandbox_disabled',
  previewsDisabled: 'sandbox_previews_disabled',
  accessMode: 'sandbox_access_mode',
} as const;

/** The feature exists at all: the Modal credentials are configured. Without them nothing sandbox-related runs. */
export function sandboxConfigured(): boolean {
  return !!env.MODAL_TOKEN_ID && !!env.MODAL_TOKEN_SECRET;
}

/** Previews additionally need the key that encrypts their Cloudflare token and claim URL. */
export function previewsConfigured(): boolean {
  return sandboxConfigured() && !!env.PREVIEW_SECRET_KEY;
}

let cache: { at: number; value: Promise<SandboxSettings> } | undefined;

async function load(): Promise<SandboxSettings> {
  const rows = await sql<{ key: string; value: unknown }[]>`select key, value from settings where key in ${sql(Object.values(SETTING_KEYS))}`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    disabled: get(SETTING_KEYS.disabled) === true,
    previewsDisabled: get(SETTING_KEYS.previewsDisabled) === true,
    accessMode: get(SETTING_KEYS.accessMode) === 'allowlist_only' ? 'allowlist_only' : 'hca_or_allowlist',
  };
}

export function sandboxSettings(): Promise<SandboxSettings> {
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    const value = load();
    cache = { at: Date.now(), value };
    value.catch(() => (cache = undefined));
  }
  return cache.value;
}

export async function setSandboxSetting<K extends keyof SandboxSettings>(key: K, value: SandboxSettings[K]): Promise<void> {
  const stored = key === 'accessMode' ? (value === 'allowlist_only' ? 'allowlist_only' : null) : value;
  await setSetting(SETTING_KEYS[key], stored);
  cache = undefined;
}
