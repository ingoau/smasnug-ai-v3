/**
 * Output scrubbing (docs/vault.md): exact matches of a secret (and its common encodings) are replaced with
 * `[redacted:<name>]` before tool output reaches the model or Slack. Best effort: a model that deliberately transforms
 * a secret (reverse, split) can still get it out, so the real defences are approvals, domain pinning and never
 * putting secrets where the model reads them.
 *
 * Secrets handed to a subagent's sandbox stay registered for that subagent (Redis, by credential id, never the value),
 * so every later sandbox / browser output of that subagent is scrubbed too.
 */
import { redis } from '../../core/redis.js';
import { log } from '../../log.js';
import { getCredentialById, revealSecret, type Credential } from './store.js';

export interface ScrubSecret {
  name: string;
  value: string;
}

const MIN_LEN = 4;

function variants(v: string): string[] {
  const out = new Set([v]);
  try {
    out.add(encodeURIComponent(v));
  } catch {
    /* lone surrogate */
  }
  out.add(Buffer.from(v).toString('base64'));
  out.add(Buffer.from(v).toString('base64').replace(/=+$/, ''));
  out.add(JSON.stringify(v).slice(1, -1));
  return [...out].filter((x) => x.length >= MIN_LEN);
}

export function scrubText(text: string, secrets: ScrubSecret[]): string {
  if (!text || secrets.length === 0) return text;
  const pairs = secrets.flatMap((s) => variants(s.value).map((v) => [v, s.name] as const)).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [v, name] of pairs) if (out.includes(v)) out = out.split(v).join(`[redacted:${name}]`);
  return out;
}

/** The secret strings of a credential worth scrubbing (password, token, username is not secret). */
export async function secretsOf(cred: Credential): Promise<ScrubSecret[]> {
  if (cred.kind === 'token') return [{ name: cred.name, value: (await revealSecret({ ...cred, kind: 'token' })).value }];
  if (cred.kind === 'login') {
    const s = await revealSecret({ ...cred, kind: 'login' });
    return [{ name: `${cred.name}:password`, value: s.password }, ...(s.totp ? [{ name: `${cred.name}:totp-seed`, value: s.totp }] : [])];
  }
  if (cred.kind === 'browser_session') return sessionSecrets(cred.name, (await revealSecret({ ...cred, kind: 'browser_session' })).state);
  return [];
}

/**
 * Token-like values in a saved browser session (Playwright storage state: cookies[].value, origins[].localStorage[].value):
 * at least 16 characters without whitespace, so ordinary short values ("1", "en-GB", "true") aren't redacted everywhere.
 */
export function sessionSecrets(name: string, state: string): ScrubSecret[] {
  const tokenLike = (v: unknown): v is string => typeof v === 'string' && v.length >= 16 && v.length <= 8192 && !/\s/.test(v);
  try {
    const s = JSON.parse(state) as { cookies?: { name?: string; value?: unknown }[]; origins?: { localStorage?: { name?: string; value?: unknown }[] }[] };
    const out: ScrubSecret[] = [];
    for (const c of s.cookies ?? []) if (tokenLike(c.value)) out.push({ name: `${name}:cookie`, value: c.value });
    for (const o of s.origins ?? []) for (const e of o.localStorage ?? []) if (tokenLike(e.value)) out.push({ name: `${name}:storage`, value: e.value });
    return out.slice(0, 200);
  } catch {
    return [];
  }
}

const key = (subagentId: string) => `vault:scrub:${subagentId}`;
const TTL_S = 26 * 3600; // a subagent expires after 24 h idle

export async function registerScrub(subagentId: string, ownerId: string, credentialId: string): Promise<void> {
  await redis.multi().sadd(key(subagentId), `${ownerId}|${credentialId}`).expire(key(subagentId), TTL_S).exec();
}

/** Secrets a subagent has been handed so far (deleted credentials drop out). */
export async function scrubSetFor(subagentId: string | undefined): Promise<ScrubSecret[]> {
  if (!subagentId) return [];
  const members = await redis.smembers(key(subagentId)).catch(() => [] as string[]);
  const out: ScrubSecret[] = [];
  for (const m of members) {
    const [ownerId, id] = m.split('|');
    const cred = ownerId && id ? await getCredentialById(ownerId, id).catch(() => null) : null;
    if (cred) out.push(...(await secretsOf(cred).catch((err) => (log.warn({ err }, 'vault scrub reveal failed'), []))));
  }
  return out;
}

/** Scrub `text` with everything this subagent was handed. */
export async function scrubForSubagent(subagentId: string | undefined, text: string): Promise<string> {
  const secrets = await scrubSetFor(subagentId);
  return scrubText(text, secrets);
}
