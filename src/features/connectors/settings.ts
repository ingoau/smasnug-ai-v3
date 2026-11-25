/**
 * Per-user connector state (docs/mcp-custom-connectors.md): permission settings (connector_settings, migration 358),
 * the Redis tool-list cache, and the revocation generation that in-flight calls watch.
 */
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { loadCatalog } from './catalog.js';
import { normalizeSettings, type ConnectorSettings, type Mode, type ToolClass } from './logic.js';

export async function getSettings(ownerId: string, slug: string): Promise<ConnectorSettings> {
  const [row] = await sql`select read_mode, write_mode, delete_mode, overrides from connector_settings where owner_id = ${ownerId} and slug = ${slug}`;
  return normalizeSettings(row as any);
}

export async function setKnob(ownerId: string, slug: string, cls: ToolClass, mode: Mode): Promise<void> {
  const col = cls === 'read' ? sql`read_mode` : cls === 'write' ? sql`write_mode` : sql`delete_mode`;
  await sql`
    insert into connector_settings (owner_id, slug, ${col}) values (${ownerId}, ${slug}, ${mode})
    on conflict (owner_id, slug) do update set ${col} = excluded.${col}, updated_at = now()`;
  await invalidateTools(ownerId, slug);
}

/** Stored as [[tool, mode], …] (see normalizeSettings). */
export async function setOverrides(ownerId: string, slug: string, overrides: Record<string, Mode>): Promise<void> {
  await sql`
    insert into connector_settings (owner_id, slug, overrides) values (${ownerId}, ${slug}, ${sql.json(Object.entries(overrides) as any)})
    on conflict (owner_id, slug) do update set overrides = excluded.overrides, updated_at = now()`;
  await invalidateTools(ownerId, slug);
}

// --- tool-list cache ------------------------------------------------------------------------------------------------

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export const TOOLS_CACHE_TTL_S = 10 * 60;
const toolsKey = (ownerId: string, slug: string) => `conn:tools:${ownerId}:${slug}`;

export async function cachedTools(ownerId: string, slug: string): Promise<CachedTool[] | null> {
  const raw = await redis.get(toolsKey(ownerId, slug)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedTool[];
  } catch {
    return null;
  }
}

export async function cacheTools(ownerId: string, slug: string, tools: CachedTool[]): Promise<void> {
  await redis.set(toolsKey(ownerId, slug), JSON.stringify(tools), 'EX', TOOLS_CACHE_TTL_S).catch(() => {});
}

export async function invalidateTools(ownerId: string, slug: string): Promise<void> {
  await redis.del(toolsKey(ownerId, slug)).catch(() => {});
}

// --- revocation -----------------------------------------------------------------------------------------------------

const genKey = (ownerId: string, slug: string) => `conn:gen:${ownerId}:${slug}`;
const ownerGenKey = (ownerId: string) => `conn:gen:${ownerId}`;

/** A snapshot of the revocation counters: a call aborts as soon as either moves. */
export async function revocationMark(ownerId: string, slug: string): Promise<string> {
  const [a, b] = await redis.mget(genKey(ownerId, slug), ownerGenKey(ownerId));
  return `${a ?? 0}:${b ?? 0}`;
}

/** Disconnect / reconnect: in-flight calls of this connection (any worker) abort. */
export async function revokeConnection(ownerId: string, slug: string): Promise<void> {
  await redis.multi().incr(genKey(ownerId, slug)).expire(genKey(ownerId, slug), 7 * 24 * 3600).exec();
  await invalidateTools(ownerId, slug);
}

/**
 * Privacy withdrawal (src/pipeline/consent.ts): their permission rows, cached tool lists, and abort anything in flight.
 * The vault rows (the connections themselves) go with deleteAllVaultData.
 */
export async function deleteConnectorData(ownerId: string): Promise<void> {
  const rows = await sql<{ slug: string }[]>`delete from connector_settings where owner_id = ${ownerId} returning slug`;
  await redis.multi().incr(ownerGenKey(ownerId)).expire(ownerGenKey(ownerId), 7 * 24 * 3600).exec();
  const slugs = new Set([...rows.map((r) => r.slug), ...(await loadCatalog().catch(() => null))?.defs.map((d) => d.slug) ?? []]);
  for (const slug of slugs) await invalidateTools(ownerId, slug);
}

/**
 * An AbortSignal that fires when the connection is revoked (polled every `everyMs`), when `parent` aborts, or after
 * `timeoutMs`. Call `stop()` when the call is over.
 */
export function revocationSignal(ownerId: string, slug: string, mark: string, o: { parent?: AbortSignal; timeoutMs: number; everyMs?: number }): { signal: AbortSignal; stop: () => void; revoked: () => boolean } {
  const ctrl = new AbortController();
  let revoked = false;
  const timer = setInterval(() => {
    revocationMark(ownerId, slug)
      .then((now) => {
        if (now !== mark && !ctrl.signal.aborted) {
          revoked = true;
          ctrl.abort(new Error('The connection was disconnected.'));
        }
      })
      .catch(() => {});
  }, o.everyMs ?? 1000);
  timer.unref?.();
  const signals = [ctrl.signal, AbortSignal.timeout(o.timeoutMs), ...(o.parent ? [o.parent] : [])];
  return { signal: AbortSignal.any(signals), stop: () => clearInterval(timer), revoked: () => revoked };
}
