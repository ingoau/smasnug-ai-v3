/**
 * The fork seed (docs/code-channels.md, Opening one: Fork): a frozen summary of the source thread up to the fork
 * point, written once when the channel opens and stored on its row (`seed_summary`). It builds on the thread's
 * rolling summary (src/context/summary.ts) when there is one: that covers the older replies, and only the messages
 * after it are read. One model call with the children's model and settings, like the rolling summary.
 */
import { generateText } from 'ai';
import { env, limits } from '../../config.js';
import { parseThreadId } from '../../core/events.js';
import { renderMessages } from '../../context/thread.js';
import { loadThreadSummary } from '../../context/summary.js';
import { capSummary, summarySystemPrompt, summaryUserPrompt } from '../../context/summary-prompt.js';
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { chatModel, MODELS, modelOptions } from '../../models.js';
import { recordModelUsage } from '../guard.js';
import type { CodeChannel } from './store.js';

const MAX_OUTPUT_TOKENS = Math.ceil(limits.threadSummaryMaxTokens * 1.5) + 2000;
/** Rendered messages read for the seed at most (newest kept; the rolling summary covers what's older). */
const MAX_MESSAGE_CHARS = limits.threadSummaryChunkTokens * 4 * 2;

/** The summariser's instructions for a seed: the rolling-summary rules plus what the seed is for. */
export function seedSystemPrompt(maxTokens: number): string {
  return `${summarySystemPrompt(maxTokens)}

This time the summary is final, not rolling: it becomes the first message of a new Slack channel that the thread is being moved (forked) into, so the people and the assistant there can carry on without reading the thread. Cover the whole thread up to the last message you are given. Write Slack markdown (short headings in *bold*, bullet points). End with a line "*Where it stands:*" naming the latest request or open question.`;
}

/** Keep the newest lines within `maxChars` (whole lines). Pure. */
export function tailLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i]!.length + 1;
    if (kept.length && used + len > maxChars) break;
    kept.push(lines[i]!);
    used += len;
  }
  return ['[older messages left out]', ...kept.reverse()].join('\n');
}

/**
 * Summarise `sourceThreadId` up to `upToTs` (inclusive; omit for all of it). Null when there is nothing to summarise.
 * Throws on a model failure (the caller decides whether to go on without a seed).
 */
export async function generateSeedSummary(o: { sourceThreadId: string; upToTs?: string | null; userId?: string | null; abortSignal?: AbortSignal }): Promise<string | null> {
  const { threadTs } = parseThreadId(o.sourceThreadId);
  const previous = await loadThreadSummary(o.sourceThreadId).catch(() => null);
  const after = previous?.coveredTs;
  const rows = await sql<{ ts: string }[]>`
    select ts from messages where thread_id = ${o.sourceThreadId} and not deleted
      ${o.upToTs ? sql`and ts::numeric <= ${o.upToTs}::numeric` : sql``}
      ${after ? sql`and (ts::numeric > ${after}::numeric or ts = ${threadTs})` : sql``}
    order by ts::numeric`;
  if (!rows.length && !previous) return null;
  const rendered = rows.length ? await renderMessages(o.sourceThreadId, rows.map((r) => r.ts)) : '';
  const signals = [o.abortSignal, AbortSignal.timeout(limits.threadSummaryTimeoutMs)].filter((s): s is AbortSignal => !!s);
  const reasoningEffort = env.CHILD_REASONING_EFFORT !== 'default' ? env.CHILD_REASONING_EFFORT : null;
  const res = await generateText({
    model: chatModel(MODELS.child),
    system: seedSystemPrompt(limits.threadSummaryMaxTokens),
    prompt: summaryUserPrompt({ previous: previous?.summary, messages: tailLines(rendered, MAX_MESSAGE_CHARS) || '(no further messages)' }),
    providerOptions: modelOptions({ effort: reasoningEffort }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 1,
    abortSignal: AbortSignal.any(signals),
  });
  void recordModelUsage({
    ...(o.userId ? { userId: o.userId } : {}),
    threadId: o.sourceThreadId,
    model: MODELS.child,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    cachedInputTokens: res.usage.inputTokenDetails?.cacheReadTokens,
  }).catch((err) => log.warn({ err }, 'recordModelUsage failed'));
  const summary = capSummary(res.text, limits.threadSummaryMaxTokens);
  return summary || null;
}

/**
 * An adopted channel with an origin link is treated as a fork of that message's thread: its seed is written on its
 * first turn (once; a Redis lock keeps two workers from both paying for it). Needs the origin's thread to be known
 * (`parent_thread_id`); returns the seed, or null when there is none to write. Never throws.
 */
export async function ensureAdoptedSeed(row: CodeChannel): Promise<string | null> {
  if (row.seedSummary || row.kind !== 'adopted' || !row.originTs || !row.parentThreadId) return row.seedSummary;
  const lock = `lock:code-channel-seed:${row.channelId}`;
  try {
    if ((await redis.set(lock, '1', 'PX', limits.threadSummaryTimeoutMs + 30_000, 'NX')) !== 'OK') return null;
    const summary = await generateSeedSummary({ sourceThreadId: row.parentThreadId, upToTs: row.originTs, userId: row.requesterId });
    if (!summary) return null;
    await sql`update code_channels set seed_summary = ${summary} where channel_id = ${row.channelId} and seed_summary is null`;
    return summary;
  } catch (err) {
    log.warn({ err, channelId: row.channelId }, 'adopted code channel seed failed');
    return null;
  }
}
