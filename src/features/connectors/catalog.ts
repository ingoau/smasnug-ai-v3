/**
 * The connector catalog (docs/mcp-custom-connectors.md, "Catalog"): admin-curated definitions in CONNECTORS_FILE,
 * re-read when the file changes. A missing file is an empty catalog. The admin enables each definition in App Home
 * (`connector_enabled:<slug>` in the shared `settings` table); only enabled ones can be connected or used.
 * A user's own connectors (custom.ts, `u-` slugs) join the list for that user only, while the admin allows them.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../../config.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { setSetting } from '../state.js';
import { vaultConfigured } from '../vault/crypto.js';
import { customConnectorsAllowed, CUSTOM_SLUG_PREFIX, getCustomConnector, isCustomSlug, listCustomConnectors } from './custom.js';
import { parseCatalog, type ConnectorDef } from './logic.js';

export interface CatalogStatus {
  path: string;
  /** 'missing': no file (empty catalog); 'error': unreadable / not JSON. */
  state: 'ok' | 'missing' | 'error';
  defs: ConnectorDef[];
  errors: string[];
}

const ENABLED_PREFIX = 'connector_enabled:';
const CHECK_EVERY_MS = 5000;
const ENABLED_TTL_MS = 3000;

let cached: { checkedAt: number; mtimeMs: number | null; status: CatalogStatus } | undefined;

export function catalogPath(): string {
  return resolve(process.cwd(), env.CONNECTORS_FILE);
}

/** The parsed catalog (re-read at most every few seconds, and only when the file's mtime changed). */
export async function loadCatalog(): Promise<CatalogStatus> {
  const path = catalogPath();
  if (cached && Date.now() - cached.checkedAt < CHECK_EVERY_MS && cached.status.path === path) return cached.status;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  if (cached && cached.status.path === path && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = Date.now();
    return cached.status;
  }
  let status: CatalogStatus;
  if (mtimeMs === null) status = { path, state: 'missing', defs: [], errors: [] };
  else {
    try {
      const parsed = parseCatalog(JSON.parse(await readFile(path, 'utf8')));
      // `u-` slugs belong to connectors people add themselves (custom.ts).
      for (const d of parsed.defs.filter((x) => isCustomSlug(x.slug))) parsed.errors.push(`${d.slug}: slugs starting with "${CUSTOM_SLUG_PREFIX}" are reserved`);
      parsed.defs = parsed.defs.filter((x) => !isCustomSlug(x.slug));
      status = { path, state: 'ok', ...parsed };
      if (parsed.errors.length) log.warn({ path, errors: parsed.errors }, 'connector catalog has invalid entries');
    } catch (err) {
      status = { path, state: 'error', defs: [], errors: [`Can't read it as JSON: ${String((err as Error)?.message ?? err).slice(0, 200)}`] };
      log.warn({ err, path }, 'connector catalog unreadable');
    }
  }
  cached = { checkedAt: Date.now(), mtimeMs, status };
  return status;
}

/** Tests: forget the cached catalog. */
export function resetCatalogCache(): void {
  cached = undefined;
  enabledCache = undefined;
}

let enabledCache: { at: number; value: Promise<Set<string>> } | undefined;

function enabledSlugs(): Promise<Set<string>> {
  if (!enabledCache || Date.now() - enabledCache.at > ENABLED_TTL_MS) {
    const value = sql<{ key: string; value: unknown }[]>`select key, value from settings where key like ${`${ENABLED_PREFIX}%`}`.then(
      (rows) => new Set(rows.filter((r) => r.value === true).map((r) => r.key.slice(ENABLED_PREFIX.length))),
    );
    enabledCache = { at: Date.now(), value };
    value.catch(() => (enabledCache = undefined));
  }
  return enabledCache.value;
}

export async function setConnectorEnabled(slug: string, enabled: boolean): Promise<void> {
  await setSetting(`${ENABLED_PREFIX}${slug}`, enabled);
  enabledCache = undefined;
}

/** The feature is on at all: a vault key is configured. */
export function connectorsConfigured(): boolean {
  return vaultConfigured();
}

/**
 * Definitions `ownerId` can use: the catalog's that the admin enabled, then their own custom ones (while the admin
 * allows them). None without a vault key; a failed settings read counts as none.
 */
export async function enabledConnectors(ownerId: string): Promise<ConnectorDef[]> {
  if (!connectorsConfigured()) return [];
  const status = await loadCatalog();
  const on = status.defs.length ? await enabledSlugs().catch(() => new Set<string>()) : new Set<string>();
  const catalog = status.defs.filter((d) => on.has(d.slug));
  const custom = (await customConnectorsAllowed()) ? await listCustomConnectors(ownerId).catch(() => []) : [];
  return [...catalog, ...custom];
}

/** One definition `ownerId` can use (a catalog one the admin enabled, or their own custom one). */
export async function enabledConnector(slug: string | undefined, ownerId: string): Promise<ConnectorDef | null> {
  if (!slug || !connectorsConfigured()) return null;
  if (isCustomSlug(slug)) return (await customConnectorsAllowed()) ? getCustomConnector(ownerId, slug).catch(() => null) : null;
  const status = await loadCatalog();
  const def = status.defs.find((d) => d.slug === slug);
  if (!def) return null;
  return (await enabledSlugs().catch(() => new Set<string>())).has(slug) ? def : null;
}

/** Every definition with its enabled flag (admin section). */
export async function catalogWithFlags(): Promise<{ status: CatalogStatus; enabled: Set<string> }> {
  const status = await loadCatalog();
  const enabled = await enabledSlugs().catch(() => new Set<string>());
  return { status, enabled };
}
