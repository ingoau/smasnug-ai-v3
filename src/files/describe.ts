/**
 * Descriptions of uploads: generated on the first read_file / ask_file of an upload that has none, as a cheap side
 * call (the gate's model settings: reasoning off, short output) that never blocks the turn. Stored and shown in every
 * later context line. The text is model output about untrusted content, so it is sanitised and length-capped
 * (format.ts sanitizeDescription) like any description.
 */
import { generateText, type ModelMessage } from 'ai';
import { redis } from '../core/redis.js';
import { recordModelUsage } from '../features/guard.js';
import { chatModel, MODELS } from '../models.js';
import { log } from '../log.js';
import { fileKind, formatBytes, sanitizeFileName } from './format.js';
import { loadImageForModel } from './images.js';
import { describeFileSystemPrompt, describeFileUserPrompt } from './prompts.js';
import { setDescription, type FileMeta } from './store.js';

const TEXT_SAMPLE_CHARS = 8000;
const CLAIM_TTL_S = 600;

export interface DescribeInput {
  meta: FileMeta;
  /** The file's text (text files), when the caller already has it. */
  text?: string;
  userId: string;
  threadId: string;
}

async function generateWithModel(input: DescribeInput): Promise<string> {
  const header = `${sanitizeFileName(input.meta.name)} (${fileKind(input.meta.mime, input.meta.name)}, ${formatBytes(input.meta.size)})`;
  let messages: ModelMessage[];
  if (input.text !== undefined) {
    messages = [{ role: 'user', content: describeFileUserPrompt({ header, text: input.text.slice(0, TEXT_SAMPLE_CHARS) }) }];
  } else {
    const img = await loadImageForModel(input.meta);
    messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: describeFileUserPrompt({ header }) },
          { type: 'file', mediaType: img.mediaType, data: { type: 'data', data: img.data } },
        ],
      },
    ];
  }
  const res = await generateText({
    model: chatModel(MODELS.gate),
    system: describeFileSystemPrompt(),
    messages,
    providerOptions: { openrouter: { reasoning: { effort: 'none' }, usage: { include: true } } },
    maxOutputTokens: 120,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
  });
  void recordModelUsage({
    userId: input.userId,
    threadId: input.threadId,
    model: MODELS.gate,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    cachedInputTokens: res.usage.inputTokenDetails?.cacheReadTokens,
  }).catch((err) => log.warn({ err }, 'recordModelUsage failed'));
  return res.text;
}

/** Produces the description text (tests replace it; the default makes a model call). */
export const describer = { generate: generateWithModel };

const pending = new Set<Promise<void>>();

/** Wait for in-flight description calls (tests, shutdown). */
export async function settleDescriptions(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Fire-and-forget: describe an upload that has no description yet (one call per file across workers: a Redis claim).
 * Only images and text are described.
 */
export function requestDescription(input: DescribeInput): void {
  const { meta } = input;
  if (meta.description || meta.origin !== 'upload' || meta.internal) return;
  const kind = fileKind(meta.mime, meta.name);
  if (kind !== 'image' && input.text === undefined) return;
  // Non-live tests never make the real model call (they stub `describer.generate` when they need it).
  if (describer.generate === generateWithModel && process.env.VITEST && process.env.LIVE !== '1') return;
  const p = (async () => {
    const claimed = await redis.set(`file-desc:${meta.id}`, '1', 'EX', CLAIM_TTL_S, 'NX');
    if (!claimed) return;
    const text = await describer.generate(input);
    const stored = await setDescription(meta.id, text, 'model');
    if (stored) meta.description = stored;
  })()
    .catch((err) => log.warn({ err, fileId: meta.id }, 'file description failed'))
    .finally(() => pending.delete(p));
  pending.add(p);
}
