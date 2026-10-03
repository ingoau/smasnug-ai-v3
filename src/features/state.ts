/**
 * Kill-switch settings and the user block list, cached in-process for a few seconds so entry checks stay cheap.
 * Writes invalidate the local cache; other workers pick changes up within CACHE_TTL_MS.
 */
import { sql } from '../db/index.js';

const CACHE_TTL_MS = 3000;

export interface UserBlock {
  userId: string;
  suspended: boolean;
  sendBlocked: boolean;
  reason: string | null;
  createdAt: Date;
}

export interface GuardState {
  paused: boolean;
  disabledChannels: Set<string>;
  blocks: Map<string, UserBlock>;
}

let cache: { at: number; state: Promise<GuardState> } | undefined;

async function load(): Promise<GuardState> {
  const [settings, blocks] = await Promise.all([
    sql<{ key: string; value: unknown }[]>`select key, value from settings where key = 'paused' or key like 'channel_disabled:%'`,
    sql<UserBlock[]>`select user_id, suspended, send_blocked, reason, created_at from user_blocks where suspended or send_blocked`,
  ]);
  const state: GuardState = { paused: false, disabledChannels: new Set(), blocks: new Map() };
  for (const s of settings) {
    if (s.key === 'paused') state.paused = s.value === true;
    else if (s.value === true) state.disabledChannels.add(s.key.slice('channel_disabled:'.length));
  }
  for (const b of blocks) state.blocks.set(b.userId, b);
  return state;
}

export function getState(): Promise<GuardState> {
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    const state = load();
    cache = { at: Date.now(), state };
    state.catch(() => (cache = undefined));
  }
  return cache.state;
}

export function invalidateState() {
  cache = undefined;
}

export async function setSetting(key: string, value: unknown | null) {
  if (value === null || value === false) await sql`delete from settings where key = ${key}`;
  else
    await sql`insert into settings (key, value) values (${key}, ${sql.json(value as any)})
              on conflict (key) do update set value = excluded.value, updated_at = now()`;
  invalidateState();
}

export const setPaused = (paused: boolean) => setSetting('paused', paused);
export const setChannelDisabled = (channelId: string, disabled: boolean) => setSetting(`channel_disabled:${channelId}`, disabled);

/** Upsert a user's block flags; rows with neither flag set are removed. */
export async function setBlock(userId: string, patch: { suspended?: boolean; sendBlocked?: boolean; reason?: string }) {
  await sql`
    insert into user_blocks (user_id, suspended, send_blocked, reason)
    values (${userId}, ${patch.suspended ?? false}, ${patch.sendBlocked ?? false}, ${patch.reason ?? null})
    on conflict (user_id) do update set
      suspended = coalesce(${patch.suspended ?? null}::boolean, user_blocks.suspended),
      send_blocked = coalesce(${patch.sendBlocked ?? null}::boolean, user_blocks.send_blocked),
      reason = coalesce(${patch.reason ?? null}, user_blocks.reason)`;
  await sql`delete from user_blocks where user_id = ${userId} and not suspended and not send_blocked`;
  invalidateState();
}

export async function listBlocks(): Promise<UserBlock[]> {
  return [...(await getState()).blocks.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
