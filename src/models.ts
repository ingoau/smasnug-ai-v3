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

/**
 * Hack Club AI's daily budget ($3/day per user, resets at UTC midnight) runs out with a 402, or with a 429 whose
 * message says the request "would exceed the OpenRouter top-up wait spending limit". Matched on the error text so a
 * budget 429 isn't treated as an ordinary rate limit. Kept specific: no bare "limit" / "rate limit" / "quota".
 */
export const BUDGET_EXHAUSTED_RE =
  /spending[ _-]limit|top[ -]?up|\bbudget\b|insufficient[ _](?:credits?|balance|funds)|out of credits?|credits? (?:exhausted|depleted)/i;

export type ProviderFailureKind = 'budget' | 'rate_limit' | 'auth' | 'other';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  /** Skip the provider until this time (ms); `now` (no cooldown) for 'other'. */
  until: number;
  reason: string;
}

/** Start of the next UTC day (when Hack Club's daily budget resets). */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Classifies a failed provider call from its HTTP status (if any), its error text and Retry-After:
 *  - budget: 402, or a 4xx / status-less error whose text matches BUDGET_EXHAUSTED_RE → skip until UTC midnight;
 *  - rate_limit: any other 429 → Retry-After seconds, else 60 s;
 *  - auth: 401 / 403 → 10 min;
 *  - other: no cooldown.
 */
export function classifyProviderFailure(f: { status?: number; text?: string; retryAfterSec?: number }, now = Date.now()): ProviderFailure {
  const { status, text = '' } = f;
  if (status === 402) return { kind: 'budget', until: nextUtcMidnight(now), reason: 'HTTP 402 (daily budget spent)' };
  if ((status === undefined || (status >= 400 && status < 500)) && BUDGET_EXHAUSTED_RE.test(text)) {
    return { kind: 'budget', until: nextUtcMidnight(now), reason: `${status ? `HTTP ${status}` : 'error'} mentions a spending limit (daily budget spent)` };
  }
  if (status === 429) {
    const s = f.retryAfterSec;
    return { kind: 'rate_limit', until: now + (s !== undefined && Number.isFinite(s) && s > 0 ? s * 1000 : 60_000), reason: 'HTTP 429 (rate limited)' };
  }
  if (status === 401 || status === 403) return { kind: 'auth', until: now + 10 * 60_000, reason: `HTTP ${status} (refused)` };
  return { kind: 'other', until: now, reason: status ? `HTTP ${status}` : 'error' };
}

/** HTTP status of an AI SDK APICallError, or the numeric `code` of an OpenRouter error object / stream error part. */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown; data?: { error?: { code?: unknown } } } | null;
  for (const v of [e?.statusCode, e?.status, e?.data?.error?.code, e?.code]) if (typeof v === 'number') return v;
  return undefined;
}

/**
 * Everything an error says about itself, joined for matching: `message`, the parsed body's `error.message` /
 * `error.metadata.raw` (APICallError `data`), the raw `responseBody`, and a nested `error` / `metadata.raw` (OpenRouter
 * error objects in stream error parts).
 */
export function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  const e = err as {
    message?: unknown;
    responseBody?: unknown;
    data?: { error?: { message?: unknown; metadata?: { raw?: unknown } } };
    error?: { message?: unknown } | string;
    metadata?: { raw?: unknown };
  } | null;
  const parts = [
    e?.message,
    e?.data?.error?.message,
    e?.data?.error?.metadata?.raw,
    e?.metadata?.raw,
    e?.responseBody,
    typeof e?.error === 'string' ? e.error : e?.error?.message,
  ];
  const out: string[] = [];
  for (const p of parts) if (typeof p === 'string' && p && !out.some((o) => o.includes(p))) out.push(p);
  return out.join(' | ');
}

/** `Retry-After` (seconds) from an APICallError's response headers. */
function retryAfterOf(err: unknown): number | undefined {
  const v = Number((err as { responseHeaders?: Record<string, string> } | null)?.responseHeaders?.['retry-after']);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function classifyProviderError(err: unknown, now = Date.now()): ProviderFailure {
  return classifyProviderFailure({ status: errorStatus(err), text: errorText(err), retryAfterSec: retryAfterOf(err) }, now);
}

/**
 * When to skip a primary provider. A cooldown only ever extends (a late rate-limit 429 can't shorten a budget skip),
 * and a budget skip is logged once per window rather than on every in-flight call that hits it.
 */
export class ProviderCooldown {
  private until = 0;
  private budgetLoggedUntil = 0;
  constructor(readonly provider: string) {}

  active(now = Date.now()): boolean {
    return now < this.until;
  }

  /** When the current cooldown ends (0 if none was ever set). */
  get skipUntil(): number {
    return this.until;
  }

  /** Records a classified failure and logs it (budget: once per window). */
  note(f: ProviderFailure, fields: Record<string, unknown> = {}, now = Date.now()): ProviderFailure {
    this.until = Math.max(this.until, f.until);
    if (f.kind === 'budget') {
      if (this.budgetLoggedUntil === f.until) return f;
      this.budgetLoggedUntil = f.until;
      log.warn(
        { provider: this.provider, ...fields, reason: f.reason, skipUntil: new Date(f.until).toISOString() },
        `${this.provider}: daily budget exhausted, skipping it until UTC midnight`,
      );
    } else {
      log.warn(
        { provider: this.provider, ...fields, kind: f.kind, reason: f.reason, cooldownMs: Math.max(0, this.until - now) },
        `${this.provider} failed, falling back`,
      );
    }
    return f;
  }

  reset(): void {
    this.until = 0;
    this.budgetLoggedUntil = 0;
  }
}

/** Hack Club AI chat completions: while active, calls go straight to OpenRouter. */
const primaryCooldown = new ProviderCooldown('hack club ai');

function noteFailure(err: unknown, modelId: string): void {
  const message = typeof (err as Error)?.message === 'string' ? (err as Error).message : errorText(err);
  primaryCooldown.note(classifyProviderError(err), { modelId, status: errorStatus(err), err: message.slice(0, 300) });
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
  const usePrimary = () => !primaryCooldown.active();
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
  primaryCooldown.reset();
}
