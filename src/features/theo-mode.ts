/**
 * Theo mode: a runtime setting (shared `settings` table, key `theo_mode`, off by default) that swaps the front
 * prompt's "# Voice" section for `src/agent/prompts/theo.md`. Toggled by the admin in App Home; cached in-process
 * for a few seconds like the other settings, so other workers pick a change up within CACHE_TTL_MS.
 */
import { sql } from '../db/index.js';
import { setSetting } from './state.js';

export const THEO_MODE_KEY = 'theo_mode';
const CACHE_TTL_MS = 3000;

let cache: { at: number; value: Promise<boolean> } | undefined;

async function load(): Promise<boolean> {
  const [row] = await sql<{ value: unknown }[]>`select value from settings where key = ${THEO_MODE_KEY}`;
  return row?.value === true;
}

/** Theo mode is on. A failed settings read counts as off (the default voice). */
export function theoModeEnabled(): Promise<boolean> {
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    const value = load();
    cache = { at: Date.now(), value };
    value.catch(() => (cache = undefined));
  }
  return cache.value.catch(() => false);
}

export async function setTheoMode(enabled: boolean): Promise<void> {
  await setSetting(THEO_MODE_KEY, enabled);
  cache = undefined;
}
