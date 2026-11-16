/**
 * The `code_channels` kill switch (docs/code-channels.md, Status). Off by default: the feature exists only with
 * `CODE_CHANNELS=1`, and the admin can switch it off at runtime with the `code_channels_disabled` setting (shared
 * `settings` table, cached in-process for a few seconds like the guard's state). Everything code-channel related
 * (the tool, the button, intake routing, the archive sweep) checks `codeChannelsEnabled()`.
 */
import { env } from '../../config.js';
import { sql } from '../../db/index.js';
import { setSetting } from '../state.js';

export const CODE_CHANNELS_DISABLED_KEY = 'code_channels_disabled';
const CACHE_TTL_MS = 3000;

/** The deployment opted in (`CODE_CHANNELS=1`). Without it nothing code-channel related runs. */
export function codeChannelsConfigured(): boolean {
  return env.CODE_CHANNELS === '1';
}

let cache: { at: number; value: Promise<boolean> } | undefined;

async function loadDisabled(): Promise<boolean> {
  const [row] = await sql<{ value: unknown }[]>`select value from settings where key = ${CODE_CHANNELS_DISABLED_KEY}`;
  return row?.value === true;
}

/** The runtime switch is off (admin). Cached for a few seconds. */
export function codeChannelsDisabled(): Promise<boolean> {
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    const value = loadDisabled();
    cache = { at: Date.now(), value };
    value.catch(() => (cache = undefined));
  }
  return cache.value;
}

/** The one check: configured and not switched off. A failed settings read counts as off (fail closed). */
export async function codeChannelsEnabled(): Promise<boolean> {
  if (!codeChannelsConfigured()) return false;
  return !(await codeChannelsDisabled().catch(() => true));
}

export async function setCodeChannelsDisabled(disabled: boolean): Promise<void> {
  await setSetting(CODE_CHANNELS_DISABLED_KEY, disabled);
  cache = undefined;
}
