/**
 * Vault store (docs/vault.md): per-user credentials. Secrets are sealed with the owner's key (crypto.ts) and only
 * opened by code that injects them into one outbound request; listing functions never return them.
 */
import { limits } from '../../config.js';
import { sql } from '../../db/index.js';
import { openFor, sealFor, vaultConfigured } from './crypto.js';

export type CredentialKind = 'token' | 'login' | 'connector' | 'browser_session';

export interface CredentialMeta {
  /**
   * Hosts this credential may be sent to / typed into (subdomains included). Empty = not tied to a website: it can
   * only reach a subagent's sandbox as a file (/work/.vault/<name>), never an outbound request the bot makes.
   */
  domains?: string[];
  /** token: request header to put it in (default Authorization) and scheme prefix (default Bearer; '' = raw). */
  header?: string;
  scheme?: string;
  /** login: has a TOTP seed (the bot generates the codes). */
  totp?: boolean;
  /** Who saved it: the owner in App Home, or the agent (save_credential). */
  savedBy?: 'user' | 'agent';
  /** connector: catalog slug and how it authenticates. */
  connector?: string;
  auth?: 'api_key' | 'oauth';
  /** Free text the owner wrote ("read-only GitHub token for my repos"). */
  note?: string;
}

export interface Credential {
  id: string;
  ownerId: string;
  name: string;
  kind: CredentialKind;
  service: string | null;
  meta: CredentialMeta;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

export type SecretOf<K extends CredentialKind> = K extends 'token'
  ? { value: string }
  : K extends 'login'
    ? { username: string; password: string; /** base32 TOTP seed (or an otpauth:// URI) */ totp?: string }
    : K extends 'browser_session'
      ? { state: string }
      : Record<string, unknown>;

export class VaultError extends Error {}

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

export function validName(name: string): boolean {
  return NAME_RE.test(name);
}

/** "example.com", "https://api.example.com/x" → host names; drops junk. */
export function parseDomains(raw: string | string[] | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : (raw ?? '').split(/[\s,]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = new Set<string>();
  for (const p of parts) {
    let host = p;
    try {
      if (/^[a-z]+:\/\//.test(p)) host = new URL(p).hostname;
    } catch {
      continue;
    }
    host = host.replace(/^\*\./, '').replace(/\.$/, '').replace(/\/.*$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) out.add(host);
  }
  return [...out];
}

/** Host matches one of `domains` exactly or as a subdomain. */
export function hostAllowed(host: string, domains: string[] | undefined): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (domains ?? []).some((d) => h === d || h.endsWith(`.${d}`));
}

function toCredential(r: any): Credential {
  return {
    id: r.id,
    ownerId: r.ownerId,
    name: r.name,
    kind: r.kind,
    service: r.service ?? null,
    meta: r.meta ?? {},
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt ?? null,
  };
}

const COLS = sql`id, owner_id, name, kind, service, meta, created_at, updated_at, last_used_at`;

export async function listCredentials(ownerId: string, kinds?: CredentialKind[]): Promise<Credential[]> {
  const rows = kinds
    ? await sql`select ${COLS} from vault_credentials where owner_id = ${ownerId} and kind = any(${kinds}) order by name`
    : await sql`select ${COLS} from vault_credentials where owner_id = ${ownerId} order by name`;
  return rows.map(toCredential);
}

export async function getCredential(ownerId: string, name: string): Promise<Credential | null> {
  const [r] = await sql`select ${COLS} from vault_credentials where owner_id = ${ownerId} and name = ${normalizeName(name)}`;
  return r ? toCredential(r) : null;
}

export async function getCredentialById(ownerId: string, id: string): Promise<Credential | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await sql`select ${COLS} from vault_credentials where owner_id = ${ownerId} and id = ${id}`;
  return r ? toCredential(r) : null;
}

/**
 * Create or replace (same owner + name, same kind) a credential. Throws VaultError with a user-facing message.
 */
export async function saveCredential<K extends CredentialKind>(o: {
  ownerId: string;
  name: string;
  kind: K;
  service?: string | null;
  meta?: CredentialMeta;
  secret: SecretOf<K>;
}): Promise<Credential> {
  if (!vaultConfigured()) throw new VaultError('The vault is not set up on this bot.');
  const name = normalizeName(o.name);
  if (!validName(name)) throw new VaultError('Names use lowercase letters, digits, "-", "_" or "." (up to 40 characters).');
  const plain = JSON.stringify(o.secret);
  if (Buffer.byteLength(plain) > limits.vaultMaxSecretBytes) throw new VaultError('That secret is too big to store.');
  const [existing] = await sql<{ kind: string }[]>`select kind from vault_credentials where owner_id = ${o.ownerId} and name = ${name}`;
  if (existing && existing.kind !== o.kind) throw new VaultError(`You already have a ${existing.kind} called "${name}". Pick another name or delete it first.`);
  if (!existing) {
    const [{ n }] = (await sql<{ n: number }[]>`select count(*)::int as n from vault_credentials where owner_id = ${o.ownerId}`) as any;
    if (n >= limits.vaultMaxCredentials) throw new VaultError(`You can store up to ${limits.vaultMaxCredentials} credentials. Delete one first.`);
  }
  const enc = sealFor(o.ownerId, plain);
  const [r] = await sql`
    insert into vault_credentials (owner_id, name, kind, service, meta, secret_enc)
    values (${o.ownerId}, ${name}, ${o.kind}, ${o.service ?? null}, ${sql.json((o.meta ?? {}) as any)}, ${enc})
    on conflict (owner_id, name) do update
      set service = excluded.service, meta = excluded.meta, secret_enc = excluded.secret_enc, updated_at = now()
    returning ${COLS}`;
  return toCredential(r);
}

/** Replace only the secret (e.g. refreshed OAuth tokens). */
export async function updateSecret<K extends CredentialKind>(cred: Pick<Credential, 'id' | 'ownerId'>, secret: SecretOf<K>): Promise<void> {
  await sql`update vault_credentials set secret_enc = ${sealFor(cred.ownerId, JSON.stringify(secret))}, updated_at = now()
            where id = ${cred.id} and owner_id = ${cred.ownerId}`;
}

/**
 * The decrypted secret. Only for code that injects it into one request; never return it to a model, log it, or put
 * it in a thread event.
 */
export async function revealSecret<K extends CredentialKind>(cred: Pick<Credential, 'id' | 'ownerId' | 'kind'> & { kind: K }): Promise<SecretOf<K>> {
  const [r] = await sql<{ secretEnc: Buffer }[]>`select secret_enc from vault_credentials where id = ${cred.id} and owner_id = ${cred.ownerId}`;
  if (!r) throw new VaultError('That credential was deleted.');
  return JSON.parse(openFor(cred.ownerId, r.secretEnc)) as SecretOf<K>;
}

export async function touchCredential(id: string): Promise<void> {
  await sql`update vault_credentials set last_used_at = now() where id = ${id}`;
}

export async function deleteCredential(ownerId: string, id: string): Promise<Credential | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await sql`delete from vault_credentials where owner_id = ${ownerId} and id = ${id} returning ${COLS}`;
  return r ? toCredential(r) : null;
}

/** Privacy withdrawal: everything the vault holds for this user. Returns how many credentials were deleted. */
export async function deleteAllVaultData(ownerId: string): Promise<number> {
  const rows = await sql`delete from vault_credentials where owner_id = ${ownerId} returning id`;
  await sql`delete from vault_approvals where owner_id = ${ownerId}`;
  await sql`delete from vault_grants where owner_id = ${ownerId}`;
  await sql`delete from vault_audit where owner_id = ${ownerId}`;
  return rows.length;
}

/** What the model may know about a credential (never the secret). */
export function describeCredential(c: Credential): string {
  const kind = c.kind === 'token' ? 'API key / secret' : c.kind === 'login' ? `login${c.meta.totp ? ' + TOTP' : ''}` : c.kind.replace('_', ' ');
  const bits = [`${c.name} (${kind}${c.service ? `, ${c.service}` : ''})`];
  bits.push(c.meta.domains?.length ? `for ${c.meta.domains.join(', ')}` : 'not tied to a website (sandbox file only)');
  if (c.meta.note) bits.push(`note: ${c.meta.note.slice(0, 200)}`);
  return bits.join(' · ');
}
