// OWNER: tools/context module.
/**
 * Rolling thread summary: a per-thread summary of every reply older than the history window in the front agent's
 * prompt (window.ts decides the window and when the summary should advance). Updated in the background on the
 * `thread-summary` queue, never during a turn: each update is the previous summary + the newly dropped replies →
 * new summary, one model call per batch (children's model and settings, like ask_thread). Never re-reads what the
 * summary already covers.
 *
 * Idempotent and race-free: jobs are keyed by (thread, target ts); a Redis lock per thread keeps two workers from
 * spending model calls on the same thread at once, and every write is conditional on the covered ts it started from.
 */
import { generateText } from 'ai';
import { env, limits } from '../config.js';
import { sql } from '../db/index.js';
import { enqueue, QUEUE } from '../core/queues.js';
import { getBotIdentity } from '../core/slack.js';
import { parseThreadId } from '../core/events.js';
import type { StoredMessage } from '../core/types.js';
import { recordModelUsage } from '../features/guard.js';
import { chatModel, MODELS } from '../models.js';
import { acquireLock } from '../pipeline/lock.js';
import { log } from '../log.js';
import { compareTs, formatMessage, userIdsIn, type FormatEnv, type RenderMsg } from './format.js';
import { fromStored } from './slack-messages.js';
import { getUserNames } from './users.js';
import { capSummary, chunkLines, summarySystemPrompt, summaryUserPrompt } from './summary-prompt.js';

export interface ThreadSummary {
  summary: string;
  coveredTs: string;
  coveredCount: number;
  updatedAt: Date;
}

export interface ThreadSummaryJob {
  threadId: string;
  targetTs: string;
}

const LOCK_TTL_MS = limits.threadSummaryTimeoutMs + 30_000;
const MAX_OUTPUT_TOKENS = Math.ceil(limits.threadSummaryMaxTokens * 1.5) + 2000; // + reasoning headroom
const PARENT_CHARS = 2000;

export const summaryLockKey = (threadId: string) => `lock:thread-summary:${threadId}`;
/** BullMQ job ids can't contain ':'. Same (thread, target) → same job, so repeated renders enqueue it once. */
export const summaryJobId = (threadId: string, targetTs: string) => `sum-${threadId.replaceAll(':', '_')}-${targetTs}`;

/** Another worker holds the thread's summary lock: BullMQ retries the job with backoff. */
export class SummaryBusy extends Error {}

export async function loadThreadSummary(threadId: string): Promise<ThreadSummary | null> {
  const [row] = await sql<ThreadSummary[]>`select summary, covered_ts, covered_count, updated_at from thread_summaries where thread_id = ${threadId}`;
  return row ?? null;
}

/** Ask the background job to fold every reply up to `targetTs` into the summary. Fire-and-forget for callers. */
export async function requestThreadSummary(threadId: string, targetTs: string): Promise<void> {
  await enqueue(QUEUE.threadSummary, { threadId, targetTs } satisfies ThreadSummaryJob, {
    jobId: summaryJobId(threadId, targetTs),
    attempts: 4,
    backoff: { type: 'exponential', delay: 5_000 },
    // Removed when done (either way): a later render can re-request the same target, which is then a no-op or a retry.
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** Replies (not the parent) in (afterTs, upToTs], oldest first, from the stored copies (`##` messages are never stored). */
async function loadRange(threadId: string, rootTs: string, afterTs: string | undefined, upToTs: string): Promise<(RenderMsg & { storedAt: Date })[]> {
  const rows = await sql<(StoredMessage & { createdAt: Date })[]>`
    select * from messages where thread_id = ${threadId} and not deleted and ts <> ${rootTs}
      and ts::numeric <= ${upToTs}::numeric ${afterTs ? sql`and ts::numeric > ${afterTs}::numeric` : sql``}`;
  return rows.map((r) => ({ ...fromStored(r), storedAt: r.createdAt })).sort((a, b) => compareTs(a.ts, b.ts));
}

async function loadParent(channelId: string, rootTs: string): Promise<RenderMsg | null> {
  const [row] = await sql<StoredMessage[]>`select * from messages where channel_id = ${channelId} and ts = ${rootTs} and not deleted`;
  return row ? fromStored(row) : null;
}

async function formatEnvFor(msgs: RenderMsg[]): Promise<FormatEnv> {
  const [names, self] = await Promise.all([getUserNames(userIdsIn(msgs)), getBotIdentity().catch(() => undefined)]);
  // No image ids: images stay `[file: …]` placeholders for the summariser.
  return { names, imageIds: new Map(), self: { ...self, name: env.BOT_DISPLAY_NAME }, maxChars: limits.threadSummaryMessageTokens * 4 };
}

/**
 * Advance the thread's summary to cover every reply up to `targetTs`. Returns how many model calls it made. No-op
 * when the summary already covers it. Throws SummaryBusy while another worker is updating the same thread.
 */
export async function processThreadSummary(job: ThreadSummaryJob, opts: { abortSignal?: AbortSignal } = {}): Promise<{ calls: number }> {
  const { threadId, targetTs } = job;
  const lock = await acquireLock(summaryLockKey(threadId), LOCK_TTL_MS);
  if (!lock) throw new SummaryBusy(`thread summary of ${threadId} is being updated by another worker`);
  let calls = 0;
  try {
    const { channelId, threadTs } = parseThreadId(threadId);
    const parent = await loadParent(channelId, threadTs).catch(() => null);
    for (;;) {
      if (!lock.held) throw new SummaryBusy('thread summary lock lost');
      const current = await loadThreadSummary(threadId);
      if (current && compareTs(current.coveredTs, targetTs) >= 0) return { calls };
      const range = await loadRange(threadId, threadTs, current?.coveredTs, targetTs);
      if (!range.length) {
        // Nothing to fold in (deleted, or already summarised under another target): just move the marker.
        if (current) await sql`update thread_summaries set covered_ts = ${targetTs}, updated_at = now() where thread_id = ${threadId} and covered_ts = ${current.coveredTs}`;
        return { calls };
      }
      const fenv = await formatEnvFor(parent ? [parent, ...range] : range);
      const parentLine = parent ? formatMessage({ ...parent, replyCount: undefined }, { ...fenv, maxChars: PARENT_CHARS }) : undefined;
      const lines = range.map((m) => ({ ts: m.ts, storedAt: m.storedAt, line: formatMessage(m, fenv) }));
      const batch = chunkLines(lines, limits.threadSummaryChunkTokens * 4)[0]!;
      const batchEnd = batch.length === lines.length ? targetTs : batch[batch.length - 1]!.ts;

      const reasoningEffort = env.CHILD_REASONING_EFFORT !== 'default' ? env.CHILD_REASONING_EFFORT : null;
      const signals = [opts.abortSignal, AbortSignal.timeout(limits.threadSummaryTimeoutMs)].filter((s): s is AbortSignal => !!s);
      const res = await generateText({
        model: chatModel(MODELS.child),
        system: summarySystemPrompt(limits.threadSummaryMaxTokens),
        prompt: summaryUserPrompt({ previous: current?.summary, parentLine, messages: batch.map((l) => l.line).join('\n') }),
        providerOptions: { openrouter: { ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}), usage: { include: true } } },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 1,
        abortSignal: AbortSignal.any(signals),
      });
      calls++;
      void recordModelUsage({ threadId, model: MODELS.child, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens }).catch((err) =>
        log.warn({ err }, 'recordModelUsage failed'),
      );
      const summary = capSummary(res.text, limits.threadSummaryMaxTokens);
      if (!summary) throw new Error('thread summary: the model returned no text');
      const inTok = res.usage.inputTokens ?? 0;
      const outTok = res.usage.outputTokens ?? 0;
      const oldest = new Date(Math.min(...batch.map((l) => l.storedAt.getTime())));
      // Conditional on the covered ts this update started from: a concurrent writer (lock lost) wins, this one drops.
      const written = current
        ? await sql`update thread_summaries set summary = ${summary}, covered_ts = ${batchEnd}, covered_count = covered_count + ${batch.length},
              updates = updates + 1, model = ${MODELS.child}, input_tokens = input_tokens + ${inTok}, output_tokens = output_tokens + ${outTok},
              oldest_message_at = least(oldest_message_at, ${oldest}), updated_at = now()
            where thread_id = ${threadId} and covered_ts = ${current.coveredTs} returning thread_id`
        : await sql`insert into thread_summaries (thread_id, summary, covered_ts, covered_count, updates, model, input_tokens, output_tokens, oldest_message_at)
            select ${threadId}, ${summary}, ${batchEnd}, ${batch.length}, 1, ${MODELS.child}, ${inTok}, ${outTok}, ${oldest}
            where exists (select 1 from threads where id = ${threadId})
            on conflict (thread_id) do nothing returning thread_id`;
      if (!written.length) {
        log.warn({ threadId, targetTs }, 'thread summary changed underneath (or thread gone); dropping this update');
        return { calls };
      }
      log.info({ threadId, coveredTs: batchEnd, folded: batch.length, chars: summary.length }, 'thread summary updated');
    }
  } finally {
    await lock.release().catch(() => {});
  }
}
