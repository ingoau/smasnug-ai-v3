/**
 * Vault encryption (docs/vault.md): AES-256-GCM (src/sandbox/preview/crypto.ts layout) with a per-user key derived
 * from VAULT_SECRET_KEY by HKDF-SHA256 over the owner's Slack id. A copy of one user's key opens nobody else's rows,
 * and the master key never touches Postgres.
 */
import { hkdfSync } from 'node:crypto';
import { env } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../sandbox/preview/crypto.js';

export function vaultConfigured(raw = env.VAULT_SECRET_KEY): boolean {
  if (!raw) return false;
  return Buffer.from(raw, 'base64').length === 32;
}

function masterKey(raw = env.VAULT_SECRET_KEY): Buffer {
  if (!raw) throw new Error('VAULT_SECRET_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('VAULT_SECRET_KEY must be 32 bytes, base64-encoded');
  return key;
}

const keys = new Map<string, Buffer>();

export function userKey(ownerId: string, raw?: string): Buffer {
  const cacheKey = `${raw ?? ''}\u0000${ownerId}`;
  let k = keys.get(cacheKey);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', masterKey(raw), Buffer.from('smasnug-vault-v1'), Buffer.from(`user:${ownerId}`), 32));
    if (keys.size > 5000) keys.clear();
    keys.set(cacheKey, k);
  }
  return k;
}

export function sealFor(ownerId: string, plain: string, raw?: string): Buffer {
  return encryptSecret(plain, userKey(ownerId, raw));
}

export function openFor(ownerId: string, blob: Buffer, raw?: string): string {
  return decryptSecret(blob, userKey(ownerId, raw));
}
