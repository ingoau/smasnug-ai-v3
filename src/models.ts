import { createOpenRouter, type LanguageModelV4 } from '@openrouter/ai-sdk-provider';
import { env } from './config.js';
import { log } from './log.js';

export const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_KEY });

/**
 * Hack Club AI (https://docs.ai.hackclub.com) is an OpenRouter proxy: same model ids, same request fields (tools,
 * streaming, `reasoning`, `usage.include`), so the OpenRouter provider works against it unchanged and
 * `providerOptions.openrouter` applies to both. It has no Decisions API, so the Jev gate stays on OpenRouter.
 */
export const hackclub = env.HACKCLUB_AI_KEY
  ? createOpenRouter({ apiKey: env.HACKCLUB_AI_KEY, baseURL: env.HACKCLUB_AI_URL })
  : null;

/** Model ids per role (design doc: Luna for gate, front agent and subagents). */
export const MODELS = {
  gate: env.MODEL_LUNA, // reasoning off
  front: env.MODEL_LUNA, // reasoning low
  child: env.MODEL_LUNA,
} as const;

type CallOptions = Parameters<LanguageModelV4['doGenerate']>[0];
type StreamResult = Awaited<ReturnType<LanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/** While set, calls skip the primary (Hack Club's daily budget is spent, or it rate limited / refused us). */
let primaryCooldownUntil = 0;

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number; data?: { error?: { code?: number } } };
  return e?.statusCode ?? e?.status ?? e?.data?.error?.code;
}

function noteFailure(err: unknown, modelId: string): void {
  const status = statusOf(err);
  const now = Date.now();
  if (status === 402) {
    // $3/day per account, resets at UTC midnight.
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    primaryCooldownUntil = midnight.getTime();
  } else if (status === 429) {
    const retryAfter = Number((err as { responseHeaders?: Record<string, string> })?.responseHeaders?.['retry-after']);
    primaryCooldownUntil = now + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
  } else if (status === 401 || status === 403) {
    primaryCooldownUntil = now + 10 * 60_000;
  }
  log.warn(
    { modelId, status, cooldownMs: Math.max(0, primaryCooldownUntil - now), err: (err as Error)?.message },
    'hack club ai failed, falling back to openrouter',
  );
}

function aborted(options: CallOptions): boolean {
  return options.abortSignal?.aborted === true;
}

/** Stream parts that come before any model output; an error before the first other part can still fall back. */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'raw', 'text-start', 'reasoning-start']);

/**
 * Hack Club AI first, OpenRouter on failure. A stream falls back only if it fails before producing output; once
 * text or a tool call has streamed, errors surface as usual.
 */
export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4): LanguageModelV4 {
  const usePrimary = () => Date.now() >= primaryCooldownUntil;
  return {
    specificationVersion: 'v4',
    provider: primary.provider,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    async doGenerate(options) {
      if (!usePrimary()) return fallback.doGenerate(options);
      try {
        return await primary.doGenerate(options);
      } catch (err) {
        if (aborted(options)) throw err;
        noteFailure(err, primary.modelId);
        return fallback.doGenerate(options);
      }
    },
    async doStream(options) {
      if (!usePrimary()) return fallback.doStream(options);
      let result: StreamResult;
      try {
        result = await primary.doStream(options);
      } catch (err) {
        if (aborted(options)) throw err;
        noteFailure(err, primary.modelId);
        return fallback.doStream(options);
      }
      // Hold back preamble parts until output starts, so a stream that errors first can be swapped out.
      const reader = result.stream.getReader();
      const held: StreamPart[] = [];
      for (;;) {
        let next: ReadableStreamReadResult<StreamPart>;
        try {
          next = await reader.read();
        } catch (err) {
          if (aborted(options)) throw err;
          noteFailure(err, primary.modelId);
          return fallback.doStream(options);
        }
        if (next.done) break;
        const part = next.value;
        if (part.type === 'error' && !aborted(options)) {
          reader.cancel().catch(() => {});
          noteFailure(part.error, primary.modelId);
          return fallback.doStream(options);
        }
        held.push(part);
        if (!PREAMBLE.has(part.type)) break;
      }
      const stream = new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of held) controller.enqueue(part);
        },
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (err) {
            controller.error(err);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { ...result, stream };
    },
  };
}

/** Chat model for a role: Hack Club AI when configured, OpenRouter as the fallback (or only) provider. */
export function chatModel(modelId: string): LanguageModelV4 {
  const fallback = openrouter(modelId);
  return hackclub ? withFallback(hackclub(modelId), fallback) : fallback;
}

/** Test hook. */
export function resetProviderCooldown(): void {
  primaryCooldownUntil = 0;
}
