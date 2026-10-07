/**
 * AES-256-GCM for the preview's Cloudflare token and claim URL (docs/sandbox.md D14). Layout: iv (12) | tag (16) |
 * ciphertext. The key is PREVIEW_SECRET_KEY (32 bytes, base64). The plaintext never reaches the model, thread events
 * or logs.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../config.js';

export function previewKey(raw = env.PREVIEW_SECRET_KEY): Buffer {
  if (!raw) throw new Error('PREVIEW_SECRET_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('PREVIEW_SECRET_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encryptSecret(plain: string, key = previewKey()): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer, key = previewKey()): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}
