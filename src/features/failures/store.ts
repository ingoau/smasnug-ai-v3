/** failure_reports storage (migration 344). Each report also gets a `failure_report` event so the eval detectors see it. */
import { appendEvent } from '../../core/events.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { clip, FAILURE_LIMITS, type FailureCategory, type FailureSignal } from './categories.js';

export type Evidence = { ts: string; userId: string | null; quote: string };

export interface NewFailure {
  threadId: string;
  channelId: string;
  turnId: number | null;
  source: 'self' | 'review';
  categories: FailureCategory[];
  summary: string;
  signal: FailureSignal | null;
  evidence: Evidence[];
  speakerId: string | null;
  idempotencyKey: string;
}

/** Stored, non-deleted messages of this thread by ts, quoted from our copy (never from the model). */
export async function evidenceFor(threadId: string, tss: string[]): Promise<Evidence[]> {
  const uniq = [...new Set(tss)].slice(0, FAILURE_LIMITS.evidenceMax);
  if (!uniq.length) return [];
  const rows = await sql<{ ts: string; userId: string | null; text: string }[]>`
    select ts, user_id, text from messages where thread_id = ${threadId} and ts = any(${uniq}) and not deleted order by ts::numeric`;
  return rows.map((r) => ({ ts: r.ts, userId: r.userId, quote: clip(r.text, FAILURE_LIMITS.quoteMax) }));
}

/** Insert (idempotent). Returns the new id, or null when it already existed. */
export async function recordFailure(f: NewFailure): Promise<number | null> {
  const [row] = await sql<{ id: string }[]>`
    insert into failure_reports (thread_id, channel_id, turn_id, source, categories, summary, signal, evidence, speaker_id, idempotency_key)
    values (${f.threadId}, ${f.channelId}, ${f.turnId}, ${f.source}, ${f.categories}, ${clip(f.summary, FAILURE_LIMITS.summaryMax)},
            ${f.signal}, ${sql.json(f.evidence as any)}, ${f.speakerId}, ${f.idempotencyKey})
    on conflict (idempotency_key) do nothing returning id`;
  if (!row) return null;
  const id = Number(row.id);
  // No text in the event: thread_events outlive a Slack deletion; failure_reports don't (store.ts applyDelete).
  await appendEvent(f.threadId, 'failure_report', f.source === 'self' ? 'bot' : 'system', {
    reportId: id,
    source: f.source,
    categories: f.categories,
    ...(f.turnId != null ? { turnId: f.turnId } : {}),
    messageTs: f.evidence.map((e) => e.ts),
  }).catch((err) => log.warn({ err }, 'failure_report event append failed'));
  return id;
}

/** Self reports filed in this thread in the last day. */
export async function selfReportsToday(threadId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from failure_reports where thread_id = ${threadId} and source = 'self' and created_at > now() - interval '1 day'`;
  return r?.n ?? 0;
}
