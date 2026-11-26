/**
 * Secrets typed into a vault / connector modal reach the worker through the `slack-events` queue, and BullMQ keeps
 * finished jobs in Redis. So ingress seals the submitted form state (view.state) of those modals before enqueueing,
 * and the worker opens it right before the handler reads it. Key: HKDF(VAULT_SECRET_KEY, "transport").
 */
import { hkdfSync } from 'node:crypto';
import { env } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../sandbox/preview/crypto.js';

/** callback_id prefixes whose submissions carry secrets. */
export const SEALED_VIEW_PREFIXES = ['vaultm:', 'connm:'];

function transportKey(): Buffer | null {
  const raw = env.VAULT_SECRET_KEY;
  if (!raw) return null;
  const master = Buffer.from(raw, 'base64');
  if (master.length !== 32) return null;
  return Buffer.from(hkdfSync('sha256', master, Buffer.from('smasnug-vault-v1'), Buffer.from('transport'), 32));
}

function isSealedView(body: any): boolean {
  const cb = body?.view?.callback_id;
  return (body?.type === 'view_submission' || body?.type === 'view_closed') && typeof cb === 'string' && SEALED_VIEW_PREFIXES.some((p) => cb.startsWith(p));
}

/** Ingress: replace view.state with a sealed blob (in place). Without a key the state is dropped (never queued). */
export function sealViewState(body: any): void {
  if (!isSealedView(body) || !body.view.state) return;
  const key = transportKey();
  body.view.state = key ? { sealed: encryptSecret(JSON.stringify(body.view.state), key).toString('base64') } : {};
}

/** Worker: the original view.state, or {} when it can't be opened. */
export function openViewState(body: any): { values?: Record<string, Record<string, any>> } {
  const st = body?.view?.state;
  if (!st) return {};
  if (typeof st.sealed !== 'string') return isSealedView(body) ? {} : st;
  const key = transportKey();
  if (!key) return {};
  try {
    return JSON.parse(decryptSecret(Buffer.from(st.sealed, 'base64'), key));
  } catch {
    return {};
  }
}
