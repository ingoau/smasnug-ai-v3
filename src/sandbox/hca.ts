/**
 * Hack Club Auth identity check (docs/sandbox.md D9/D10, §4.1). `GET <HCA_URL>/api/external/check?slack_id=U…` is
 * public, without auth, meant for integrations. Observed 2026-10-07: always HTTP 200 with
 * `{"result": "<value>", "note": "…"}`, `not_found` for unknown ids.
 *
 * Rules: only a boolean is stored (never the over/under-18 distinction or the status); errors, 5xx and unknown values
 * are never read as "unverified" and never cached (an HCA outage once looked like "everyone revoked"); negative
 * answers get a short Redis cache with the reason kind only. HCA is only ever asked about the speaker / subagent
 * owner, never on behalf of anyone else, and no tool takes a user id.
 */
import { env, limits } from '../config.js';
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';

/** What one HCA answer means for us. `unknown`: error, timeout, 5xx, unparseable or a value we don't know. */
export type HcaOutcome = 'verified' | 'unverified' | 'pending' | 'rejected' | 'unknown';

/** Pure: an HCA response (status + parsed body, or null when it wasn't JSON) → outcome. */
export function mapHcaResponse(status: number, body: unknown): HcaOutcome {
  if (status < 200 || status >= 300) {
    // A 404 with a definitive result body still counts; anything else is "can't tell".
    if (status !== 404) return 'unknown';
  }
  const result = body && typeof body === 'object' ? (body as { result?: unknown }).result : undefined;
  switch (result) {
    case 'verified_eligible':
    case 'verified_but_over_18':
      return 'verified';
    case 'needs_submission':
    case 'not_found':
      return 'unverified';
    case 'pending':
      return 'pending';
    case 'rejected':
      return 'rejected';
    default:
      return 'unknown';
  }
}

export type HcaReason = 'denied' | 'pending' | 'rejected' | 'unavailable';
export type HcaDecision = { ok: true } | { ok: false; reason: HcaReason };

export interface HcaRow {
  verified: boolean;
  checkedAt: Date;
}

/** Pure: can the cache answer without calling HCA? `null` = call HCA. */
export function hcaFromCache(row: HcaRow | null, negative: HcaReason | null, now: number): HcaDecision | null {
  if (row?.verified && now - row.checkedAt.getTime() < limits.hcaPositiveTtlMs) return { ok: true };
  if (negative && negative !== 'unavailable') return { ok: false, reason: negative };
  return null;
}

export interface HcaPlan {
  decision: HcaDecision;
  /** Store a fresh positive / remove a stored positive / leave the table alone. */
  write: 'positive' | 'delete' | 'none';
  /** Negative cache entry (reason kind only) and its TTL, or none. */
  negative: { reason: Exclude<HcaReason, 'unavailable'>; ttlMs: number } | null;
}

/** Pure: what to do with a fresh HCA outcome, given the stored row (the "last known positive", any age). */
export function planAfterCheck(outcome: HcaOutcome, row: HcaRow | null): HcaPlan {
  switch (outcome) {
    case 'verified':
      return { decision: { ok: true }, write: 'positive', negative: null };
    case 'unverified':
      return { decision: { ok: false, reason: 'denied' }, write: 'delete', negative: { reason: 'denied', ttlMs: limits.hcaNegativeTtlMs } };
    case 'pending':
      // Not a revocation: keep any old positive row, just don't use it while the new review is pending.
      return { decision: { ok: false, reason: 'pending' }, write: 'none', negative: { reason: 'pending', ttlMs: limits.hcaPendingTtlMs } };
    case 'rejected':
      return { decision: { ok: false, reason: 'rejected' }, write: 'delete', negative: { reason: 'rejected', ttlMs: limits.hcaNegativeTtlMs } };
    case 'unknown':
      // Never read as unverified, never cached: a stale positive still counts, else "can't check right now".
      return { decision: row?.verified ? { ok: true } : { ok: false, reason: 'unavailable' }, write: 'none', negative: null };
  }
}

const negKey = (userId: string) => `hca:neg:${userId}`;

/** The fetch HCA goes through (tests replace it). */
export const hcaClient = {
  check: async (userId: string): Promise<HcaOutcome> => {
    try {
      const url = `${env.HCA_URL.replace(/\/$/, '')}/api/external/check?slack_id=${encodeURIComponent(userId)}`;
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(limits.hcaTimeoutMs) });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {}
      return mapHcaResponse(res.status, body);
    } catch (err) {
      log.warn({ err: String((err as any)?.message ?? err) }, 'HCA check failed');
      return 'unknown';
    }
  },
};

/** Is this user HCA-verified? Uses the caches, calls HCA when needed. Never logs the outcome per user. */
export async function checkHca(userId: string): Promise<HcaDecision> {
  const [row] = await sql<HcaRow[]>`select verified, checked_at from hca_verifications where user_id = ${userId}`;
  const neg = (await redis.get(negKey(userId))) as HcaReason | null;
  const cached = hcaFromCache(row ?? null, neg, Date.now());
  if (cached) return cached;
  const outcome = await hcaClient.check(userId);
  const plan = planAfterCheck(outcome, row ?? null);
  if (plan.write === 'positive') {
    await sql`insert into hca_verifications (user_id, verified, checked_at) values (${userId}, true, now())
              on conflict (user_id) do update set verified = true, checked_at = now()`;
    await redis.del(negKey(userId));
  } else if (plan.write === 'delete') {
    await sql`delete from hca_verifications where user_id = ${userId}`;
  }
  if (plan.negative) await redis.set(negKey(userId), plan.negative.reason, 'PX', plan.negative.ttlMs);
  return plan.decision;
}
