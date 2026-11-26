/**
 * Custom connectors (docs/mcp-custom-connectors.md, "Custom connectors"): MCP servers a user adds themselves in App
 * Home ("Add connector"). Each definition belongs to its owner only: only they see it, connect it and get its tools.
 * Validated like a catalog entry (logic.ts parseCatalog: public https URL, auth), stored in `custom_connectors`
 * (migration 359) with a never-reused `u-<name>-<random>` slug, which catalog entries can't use. The admin can switch the feature off
 * (`connectors_custom_off`); existing custom connectors then stop working until it is on again.
 */
import { randomBytes } from 'node:crypto';
import { sql } from '../../db/index.js';
import { setSetting } from '../state.js';
import { parseCatalog, type ConnectorDef } from './logic.js';

export const CUSTOM_SLUG_PREFIX = 'u-';
export const MAX_CUSTOM_CONNECTORS = 10;
const OFF_KEY = 'connectors_custom_off';
const OFF_TTL_MS = 3000;

let offCache: { at: number; value: Promise<boolean> } | undefined;

/** People may add (and use) their own connectors: on unless the admin switched it off. A failed read counts as off. */
export async function customConnectorsAllowed(): Promise<boolean> {
  if (!offCache || Date.now() - offCache.at > OFF_TTL_MS) {
    const value = sql<{ value: unknown }[]>`select value from settings where key = ${OFF_KEY}`.then((r) => r[0]?.value !== true);
    offCache = { at: Date.now(), value: value.catch(() => false) };
  }
  return offCache.value;
}

export async function setCustomConnectorsAllowed(allowed: boolean): Promise<void> {
  await setSetting(OFF_KEY, !allowed);
  offCache = undefined;
}

export function isCustomSlug(slug: string): boolean {
  return slug.startsWith(CUSTOM_SLUG_PREFIX);
}

interface Row {
  slug: string;
  name: string;
  description: string;
  url: string;
  authType: 'oauth' | 'api_key';
  keyHeader: string | null;
  keyScheme: string | null;
}

function toEntry(r: Omit<Row, 'slug'> & { slug: string }) {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description,
    url: r.url,
    auth: r.authType === 'api_key' ? { type: 'api_key', ...(r.keyHeader ? { header: r.keyHeader } : {}), ...(r.keyScheme != null ? { scheme: r.keyScheme } : {}) } : { type: 'oauth' },
  };
}

/** Rows that no longer validate (e.g. the URL now resolves privately) are dropped, never used. */
function toDefs(rows: Row[]): ConnectorDef[] {
  return parseCatalog(rows.map(toEntry)).defs;
}

/** The owner's custom connectors (oldest first), whether or not the feature is currently on. */
export async function listCustomConnectors(ownerId: string): Promise<ConnectorDef[]> {
  const rows = await sql<Row[]>`
    select slug, name, description, url, auth_type, key_header, key_scheme from custom_connectors where owner_id = ${ownerId} order by created_at, slug`;
  return toDefs(rows);
}

export async function getCustomConnector(ownerId: string, slug: string): Promise<ConnectorDef | null> {
  if (!isCustomSlug(slug)) return null;
  const rows = await sql<Row[]>`
    select slug, name, description, url, auth_type, key_header, key_scheme from custom_connectors where owner_id = ${ownerId} and slug = ${slug}`;
  return toDefs(rows)[0] ?? null;
}

export interface CustomInput {
  name: string;
  url: string;
  description?: string;
  auth: 'oauth' | 'api_key';
  /** API key only: the header that carries it (default Authorization, with "Bearer"). */
  header?: string;
}

/**
 * `u-` + the name as a slug + a random suffix (max 24 characters). Never reused: a removed connector's leftovers
 * (cached tools, a connection whose delete failed) can't attach to a new one added under the same name.
 */
export function customSlug(name: string, rand: string = randomBytes(3).toString('hex').slice(0, 4)): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/, '');
  return `${CUSTOM_SLUG_PREFIX}${base || 'connector'}-${rand}`;
}

/** Validate and store a new custom connector. Returns it, or an error to show the user. */
export async function addCustomConnector(ownerId: string, input: CustomInput): Promise<{ def: ConnectorDef } | { error: string }> {
  const name = input.name.trim();
  if (!name) return { error: 'Give it a name.' };
  if (name.length > 60) return { error: 'The name is too long (60 characters at most).' };
  const header = input.auth === 'api_key' ? input.header?.trim() || 'Authorization' : undefined;
  const scheme = header && header.toLowerCase() === 'authorization' ? 'Bearer' : header ? '' : undefined;
  const entry = toEntry({ slug: customSlug(name), name, description: (input.description ?? '').trim().slice(0, 300), url: input.url.trim(), authType: input.auth, keyHeader: header ?? null, keyScheme: scheme ?? null });
  const { defs, errors } = parseCatalog([entry]);
  const def = defs[0];
  if (!def) {
    const e = (errors[0] ?? '').replace(/^#1( \([^)]*\))?: /, '');
    if (/^url/.test(e)) return { error: 'The server URL must be a public https:// address (no login details or #fragment in it).' };
    if (/header/.test(e)) return { error: 'The header name may only use letters, digits and dashes.' };
    return { error: `That doesn't work as a connector: ${e}` };
  }
  // Count, name check and insert under one per-owner lock, so two submits at once can't pass the cap together.
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`custom_connectors:${ownerId}`}))`;
    const rows = await tx<{ name: string }[]>`select name from custom_connectors where owner_id = ${ownerId}`;
    if (rows.length >= MAX_CUSTOM_CONNECTORS) return { error: `You can add up to ${MAX_CUSTOM_CONNECTORS} connectors. Remove one first.` };
    if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) return { error: `You already have a connector called "${name}".` };
    await tx`
      insert into custom_connectors (owner_id, slug, name, description, url, auth_type, key_header, key_scheme)
      values (${ownerId}, ${def.slug}, ${def.name}, ${def.description}, ${def.url}, ${input.auth}, ${header ?? null}, ${scheme ?? null})`;
    return { def };
  });
}

export async function removeCustomConnector(ownerId: string, slug: string): Promise<boolean> {
  const rows = await sql`delete from custom_connectors where owner_id = ${ownerId} and slug = ${slug} returning slug`;
  return rows.length > 0;
}

/** Privacy withdrawal: every custom connector of the user (returns their slugs, for cache cleanup). */
export async function deleteCustomConnectors(ownerId: string): Promise<string[]> {
  const rows = await sql<{ slug: string }[]>`delete from custom_connectors where owner_id = ${ownerId} returning slug`;
  return rows.map((r) => r.slug);
}

/** Tests. */
export function resetCustomCache(): void {
  offCache = undefined;
}
