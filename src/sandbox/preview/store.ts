/**
 * `previews` rows and consent records (docs/sandbox.md §3.6, §3.8). The Cloudflare token and claim URL are stored
 * encrypted (crypto.ts) and nulled at expiry or takedown.
 */
import { limits } from '../../config.js';
import { shortId } from '../../core/events.js';
import { env } from '../../config.js';
import { sql } from '../../db/index.js';
import { dailyResetAt } from '../../features/guard.js';
import { log } from '../../log.js';
import type { DeployResult } from './deploy.js';
import { decryptSecret, encryptSecret } from './crypto.js';

export type PreviewStatus = 'requested' | 'awaiting_terms' | 'deploying' | 'live' | 'expired' | 'failed' | 'refused' | 'cancelled' | 'taken_down';

export interface PreviewRow {
  id: string;
  runId: number | null;
  subagentId: string | null;
  threadId: string;
  requesterId: string;
  title: string;
  bundleFileId: string | null;
  status: PreviewStatus;
  workerName: string | null;
  url: string | null;
  accountId: string | null;
  apiTokenEnc: Buffer | null;
  claimUrlEnc: Buffer | null;
  expiresAt: Date | null;
  claimExpiresAt: Date | null;
  messageTs: string | null;
  termsPromptExpiresAt: Date | null;
  /** A request_preview call is waiting for the terms answer until then (it deploys; the accept handler doesn't queue). */
  inlineUntil: Date | null;
  error: string | null;
  createdAt: Date;
}

export const ACTIVE: PreviewStatus[] = ['requested', 'awaiting_terms', 'deploying', 'live'];

export async function getPreview(id: string): Promise<PreviewRow | null> {
  const [r] = await sql<PreviewRow[]>`select * from previews where id = ${id}`;
  return r ? { ...r, runId: r.runId == null ? null : Number(r.runId) } : null;
}

/**
 * The run's pending preview (requested / awaiting terms) is replaced by a second request in the same run (its bundle
 * is dropped); otherwise (none yet, or the earlier one is live or ended) a new row is made: a run may deploy again
 * after a fix.
 */
export async function upsertRequestedPreview(o: { runId: number; subagentId: string; threadId: string; requesterId: string; title: string; bundleFileId: string }): Promise<{ id: string; replacedBundle: string | null }> {
  const [old] = await sql<{ id: string; bundleFileId: string | null }[]>`
    select id, bundle_file_id from previews where run_id = ${o.runId} and status in ('requested', 'awaiting_terms') order by created_at desc limit 1`;
  if (old) {
    await sql`update previews set title = ${o.title}, bundle_file_id = ${o.bundleFileId} where id = ${old.id}`;
    return { id: old.id, replacedBundle: old.bundleFileId };
  }
  const id = shortId('pv');
  await sql`insert into previews (id, run_id, subagent_id, thread_id, requester_id, title, bundle_file_id, status)
            values (${id}, ${o.runId}, ${o.subagentId}, ${o.threadId}, ${o.requesterId}, ${o.title}, ${o.bundleFileId}, 'requested')`;
  return { id, replacedBundle: null };
}

/** Set or clear the inline wait mark; returns the row's status (null: no such row). */
export async function setInlineUntil(id: string, until: Date | null): Promise<PreviewStatus | null> {
  const [r] = await sql<{ status: PreviewStatus }[]>`update previews set inline_until = ${until} where id = ${id} returning status`;
  return r?.status ?? null;
}

/** The previews of these runs (newest first per run), for the results turn. */
export async function previewsOfRuns(runIds: number[]): Promise<PreviewRow[]> {
  if (!runIds.length) return [];
  return sql<PreviewRow[]>`select * from previews where run_id in ${sql(runIds)} order by run_id, created_at desc`;
}

/**
 * Previews counted against the daily caps: today's, except those that never got anywhere (cancelled before deploy).
 * The user's count starts at their last admin limit reset when that was today.
 */
export async function previewCountsToday(userId: string): Promise<{ user: number; global: number }> {
  const resetAt = await dailyResetAt(userId);
  const [r] = await sql<{ user: number; global: number }[]>`
    select count(*) filter (where requester_id = ${userId} and created_at >= ${resetAt ?? new Date(0)})::int as user, count(*)::int as global
    from previews where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc' and status <> 'cancelled'`;
  return { user: r?.user ?? 0, global: r?.global ?? 0 };
}

export async function termsAccepted(userId: string): Promise<boolean> {
  const [r] = await sql`select 1 from preview_terms where user_id = ${userId} and terms_version = ${env.PREVIEW_TERMS_VERSION}`;
  return !!r;
}

export async function acceptTerms(userId: string): Promise<void> {
  await sql`insert into preview_terms (user_id, terms_version) values (${userId}, ${env.PREVIEW_TERMS_VERSION}) on conflict do nothing`;
}

/** Move to `to` only from one of `from` (atomic). Returns the row when it moved. */
export async function transition(id: string, from: PreviewStatus[], to: PreviewStatus, extra: { error?: string | null; termsPromptExpiresAt?: Date | null; inlineUntil?: Date | null } = {}): Promise<PreviewRow | null> {
  const ended = !ACTIVE.includes(to);
  const [r] = await sql<PreviewRow[]>`
    update previews set status = ${to},
      error = coalesce(${extra.error ?? null}, error),
      terms_prompt_expires_at = ${extra.termsPromptExpiresAt === undefined ? sql`terms_prompt_expires_at` : extra.termsPromptExpiresAt},
      inline_until = ${extra.inlineUntil === undefined ? sql`inline_until` : extra.inlineUntil},
      ended_at = ${ended ? sql`now()` : sql`ended_at`},
      api_token_enc = ${ended ? null : sql`api_token_enc`},
      claim_url_enc = ${ended ? null : sql`claim_url_enc`}
    where id = ${id} and status in ${sql(from)}
    returning *`;
  return r ?? null;
}

export async function storeLive(id: string, d: DeployResult): Promise<PreviewRow | null> {
  const expiresAt = d.accountExpiresAt ?? new Date(Date.now() + limits.previewLifetimeMs);
  const claimExpiresAt = d.claimExpiresAt ?? expiresAt;
  const [r] = await sql<PreviewRow[]>`
    update previews set status = 'live', url = ${d.url}, worker_name = ${d.workerName}, account_id = ${d.accountId},
      api_token_enc = ${d.apiToken ? encryptSecret(d.apiToken) : null},
      claim_url_enc = ${d.claimUrl ? encryptSecret(d.claimUrl) : null},
      expires_at = ${expiresAt}, claim_expires_at = ${claimExpiresAt}
    where id = ${id} and status = 'deploying' returning *`;
  return r ?? null;
}

export function claimUrlOf(row: PreviewRow): string | null {
  if (!row.claimUrlEnc) return null;
  try {
    return decryptSecret(row.claimUrlEnc);
  } catch (err) {
    log.error({ previewId: row.id }, 'claim URL decrypt failed');
    return null;
  }
}

export function apiTokenOf(row: PreviewRow): string | null {
  if (!row.apiTokenEnc) return null;
  try {
    return decryptSecret(row.apiTokenEnc);
  } catch {
    log.error({ previewId: row.id }, 'preview token decrypt failed');
    return null;
  }
}

export async function setMessageTs(id: string, ts: string): Promise<void> {
  await sql`update previews set message_ts = ${ts} where id = ${id}`;
}

export async function livePreviews(limit = 20): Promise<PreviewRow[]> {
  return sql<PreviewRow[]>`select * from previews where status = 'live' order by created_at desc limit ${limit}`;
}
