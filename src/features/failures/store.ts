/**
 * failure_reports storage (migration 344). Each report also gets a `failure_report` event so the eval detectors see it.
 *
 * Reports about the same incident are merged at insert time (migration 352): a report on the same thread that is on the
 * same turn or cites an overlapping message, and shares a category, folds into the oldest such report instead of adding
 * a row (a self report the review also found, or two review findings sharing evidence). Distinct failures on one turn
 * (a wrong fact and a missed question) have no category in common and stay apart. See `mergeFailure` for how the
 * fields combine.
 */
import { appendEvent } from '../../core/events.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { cleanCategories, clip, FAILURE_LIMITS, type FailureCategory, type FailureSignal } from './categories.js';

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

/** A stored report, as far as merging needs it. */
export interface StoredFailure {
  turnId: number | null;
  source: 'self' | 'review';
  categories: string[];
  summary: string;
  signal: FailureSignal | null;
  evidence: Evidence[];
  speakerId: string | null;
  reviewVerdict: string | null;
}

/** Stored, non-deleted messages of this thread by ts, quoted from our copy (never from the model). */
export async function evidenceFor(threadId: string, tss: string[]): Promise<Evidence[]> {
  const uniq = [...new Set(tss)].slice(0, FAILURE_LIMITS.evidenceMax);
  if (!uniq.length) return [];
  const rows = await sql<{ ts: string; userId: string | null; text: string }[]>`
    select ts, user_id, text from messages where thread_id = ${threadId} and ts = any(${uniq}) and not deleted order by ts::numeric`;
  return rows.map((r) => ({ ts: r.ts, userId: r.userId, quote: clip(r.text, FAILURE_LIMITS.quoteMax) }));
}

const SIGNAL_RANK: Record<string, number> = { explicit_complaint: 4, correction: 3, self_noticed: 2, hindsight: 1 };
const signalRank = (s: string | null) => (s ? (SIGNAL_RANK[s] ?? 0) : 0);

/**
 * Pure: whether `f` is about the same incident as `r` (same thread assumed): a category in common, and the same turn
 * or an evidence message in common. Mirrors the merge-target query in `recordFailure`.
 */
export function sameIncident(
  r: Pick<StoredFailure, 'turnId' | 'evidence' | 'categories'>,
  f: Pick<NewFailure, 'turnId' | 'evidence' | 'categories'>,
): boolean {
  if (!f.categories.some((c) => r.categories.includes(c))) return false;
  if (r.turnId != null && f.turnId != null && r.turnId === f.turnId) return true;
  const tss = new Set(r.evidence.map((e) => e.ts));
  return f.evidence.some((e) => tss.has(e.ts));
}

/**
 * Pure: fold a new report into an existing one about the same incident.
 * - categories and evidence: union (the existing ones first, so a cap never drops them), evidence ordered by ts;
 * - signal and summary: from the report with the stronger signal (explicit_complaint > correction > self_noticed >
 *   hindsight), the existing one on a tie;
 * - turn and speaker: the existing ones unless missing;
 * - source: 'self' if either is (the bot noticed it), and when one side is a self report and the other a review
 *   finding, the review independently found it: review_verdict 'confirmed'. Otherwise the verdict stays.
 */
export function mergeFailure(r: StoredFailure, f: NewFailure): StoredFailure {
  const evidence = [...r.evidence];
  for (const e of f.evidence) if (!evidence.some((x) => x.ts === e.ts)) evidence.push(e);
  const capped = evidence.slice(0, FAILURE_LIMITS.evidenceMax).sort((a, b) => Number(a.ts) - Number(b.ts));
  const stronger = signalRank(f.signal) > signalRank(r.signal);
  const crossSource = r.source !== f.source;
  return {
    turnId: r.turnId ?? f.turnId,
    source: r.source === 'self' || f.source === 'self' ? 'self' : 'review',
    categories: cleanCategories([...r.categories, ...f.categories]),
    summary: stronger ? clip(f.summary, FAILURE_LIMITS.summaryMax) : r.summary,
    signal: stronger ? f.signal : r.signal,
    evidence: capped,
    speakerId: r.speakerId ?? f.speakerId,
    reviewVerdict: crossSource ? 'confirmed' : r.reviewVerdict,
  };
}

type Outcome = { id: number; merged: false } | { id: number; merged: true; verdictChanged: boolean; turnId: number | null };

/**
 * Insert, or merge into an existing report about the same incident (see the file comment). Idempotent: a key already
 * filed (as a report's own key or one merged into it) changes nothing. Returns the report's id (new or merged into),
 * or null when the key was already filed.
 */
export async function recordFailure(f: NewFailure): Promise<number | null> {
  const outcome = await sql.begin(async (tx): Promise<Outcome | null> => {
    // One writer per thread, so two reports about one incident can't both insert.
    await tx`select pg_advisory_xact_lock(hashtext(${`failure_reports:${f.threadId}`}))`;
    const [dup] = await tx`
      select 1 from failure_reports where idempotency_key = ${f.idempotencyKey}
         or (thread_id = ${f.threadId} and ${f.idempotencyKey} = any(merged_keys))`;
    if (dup) return null;
    const tss = f.evidence.map((e) => e.ts);
    // A disputed self report isn't a merge target: the review said it didn't happen, so this one stands on its own.
    const [prev] = await tx<(Omit<StoredFailure, 'turnId'> & { id: string; turnId: string | null })[]>`
      select id, turn_id, source, categories, summary, signal, evidence, speaker_id, review_verdict from failure_reports
      where thread_id = ${f.threadId} and review_verdict is distinct from 'disputed' and categories && ${f.categories}::text[]
        and (${f.turnId != null ? tx`turn_id = ${f.turnId}` : tx`false`}
             or exists (select 1 from jsonb_array_elements(evidence) e where e->>'ts' = any(${tss}::text[])))
      order by id limit 1 for update`;
    if (prev) {
      const id = Number(prev.id);
      const old: StoredFailure = { ...prev, turnId: prev.turnId == null ? null : Number(prev.turnId), evidence: Array.isArray(prev.evidence) ? prev.evidence : [] };
      const m = mergeFailure(old, f);
      await tx`
        update failure_reports set turn_id = ${m.turnId}, source = ${m.source}, categories = ${m.categories}, summary = ${m.summary},
          signal = ${m.signal}, evidence = ${sql.json(m.evidence as any)}, speaker_id = ${m.speakerId}, review_verdict = ${m.reviewVerdict},
          merged_keys = array_append(merged_keys, ${f.idempotencyKey})
        where id = ${id}`;
      return { id, merged: true, verdictChanged: m.reviewVerdict !== old.reviewVerdict, turnId: m.turnId };
    }
    const [row] = await tx<{ id: string }[]>`
      insert into failure_reports (thread_id, channel_id, turn_id, source, categories, summary, signal, evidence, speaker_id, idempotency_key)
      values (${f.threadId}, ${f.channelId}, ${f.turnId}, ${f.source}, ${f.categories}, ${clip(f.summary, FAILURE_LIMITS.summaryMax)},
              ${f.signal}, ${sql.json(f.evidence as any)}, ${f.speakerId}, ${f.idempotencyKey})
      on conflict (idempotency_key) do nothing returning id`;
    return row ? { id: Number(row.id), merged: false } : null;
  });
  if (!outcome) return null;
  const turnId = outcome.merged ? outcome.turnId : f.turnId;
  // No text in the event: thread_events outlive a Slack deletion; failure_reports don't (store.ts applyDelete).
  // A merge still gets one: the turn was reported by this source too (self_reported / review_reported flags).
  await appendEvent(f.threadId, 'failure_report', f.source === 'self' ? 'bot' : 'system', {
    reportId: outcome.id,
    source: f.source,
    categories: f.categories,
    ...(turnId != null ? { turnId } : {}),
    messageTs: f.evidence.map((e) => e.ts),
    ...(outcome.merged ? { merged: true } : {}),
  }).catch((err) => log.warn({ err }, 'failure_report event append failed'));
  if (outcome.merged && outcome.verdictChanged) {
    await appendEvent(f.threadId, 'failure_verdict', 'system', { reportId: outcome.id, verdict: 'confirmed', ...(turnId != null ? { turnId } : {}) }).catch((err) =>
      log.warn({ err }, 'failure_verdict event append failed'),
    );
  }
  if (outcome.merged) log.info({ threadId: f.threadId, reportId: outcome.id, source: f.source }, 'failure report merged into an existing one');
  return outcome.id;
}

/** Self reports filed in this thread in the last day. */
export async function selfReportsToday(threadId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from failure_reports where thread_id = ${threadId} and source = 'self' and created_at > now() - interval '1 day'`;
  return r?.n ?? 0;
}
