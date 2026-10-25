import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter, type LanguageModelV4 } from '@openrouter/ai-sdk-provider';
import { env } from './config.js';
import { log } from './log.js';

export const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_KEY });

/**
 * Hack Club AI (https://docs.ai.hackclub.com) is an OpenRouter proxy: same model ids, same request fields (tools,
 * streaming, `reasoning`, `usage.include`), so the OpenRouter provider works against it unchanged. It has no
 * Decisions API, so the Jev gate stays on OpenRouter.
 */
export const hackclub = env.HACKCLUB_AI_KEY
  ? createOpenRouter({ apiKey: env.HACKCLUB_AI_KEY, baseURL: env.HACKCLUB_AI_URL })
  : null;

/** The Anthropic API (monthly credit): Claude models after Hack Club's daily budget, before paid OpenRouter. */
export const anthropic = env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

/** Model ids per role (`sandbox`: subagents spawned with a code sandbox). See MODEL_* in config.ts. */
export const MODELS = {
  gate: env.MODEL_GATE,
  front: env.MODEL_FRONT,
  child: env.MODEL_CHILD,
  sandbox: env.MODEL_SANDBOX,
} as const;

/** 'claude-haiku-5-5' / 'anthropic/claude-haiku-5.5' → true. */
export function isClaude(modelId: string): boolean {
  return /^(anthropic\/)?claude-/.test(modelId);
}

/** Anthropic API id → OpenRouter / Hack Club id: 'claude-haiku-5-5' → 'anthropic/claude-haiku-5.5'. */
export function openrouterClaudeId(modelId: string): string {
  if (modelId.startsWith('anthropic/')) return modelId;
  return `anthropic/${modelId.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

/** OpenRouter id → Anthropic API id: 'anthropic/claude-haiku-5.5' → 'claude-haiku-5-5'. */
export function anthropicClaudeId(modelId: string): string {
  return modelId.replace(/^anthropic\//, '').replace(/\./g, '-');
}

type CallOptions = Parameters<LanguageModelV4['doGenerate']>[0];
type StreamResult = Awaited<ReturnType<LanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/**
 * Hack Club AI's daily budget ($3/day per user, resets at UTC midnight) runs out with a 402, or with a 429 whose
 * message says the request "would exceed the OpenRouter top-up wait spending limit". The Anthropic API says so with a 400
 * ("Your credit balance is too low…", or a console spend limit: "…reached your specified API usage limits…"). Matched on the error text so a
 * budget 429 isn't treated as an ordinary rate limit. Kept specific: no bare "limit" / "rate limit" / "quota".
 */
export const BUDGET_EXHAUSTED_RE =
  /spending[ _-]limit|top[ -]?up|\bbudget\b|insufficient[ _](?:credits?|balance|funds)|out of credits?|credits? (?:exhausted|depleted)|credit balance is too low|reached your specified API usage limits/i;

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

/** Per-provider cooldowns, shared by every model on that provider (Hack Club's budget is per key, not per model). */
const hackclubCooldown = new ProviderCooldown('hack club ai');
const anthropicCooldown = new ProviderCooldown('anthropic');

function noteFailure(cooldown: ProviderCooldown, err: unknown, modelId: string): void {
  const message = typeof (err as Error)?.message === 'string' ? (err as Error).message : errorText(err);
  cooldown.note(classifyProviderError(err), { modelId, status: errorStatus(err), err: message.slice(0, 300) });
}

function aborted(options: CallOptions): boolean {
  return options.abortSignal?.aborted === true;
}

/** Stream parts that come before any model output; an error before the first other part can still fall back. */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'raw', 'text-start', 'reasoning-start']);

/**
 * `primary` first, `fallback` on failure (and while `cooldown` is active). A stream falls back only if it fails
 * before producing output; once text or a tool call has streamed, errors surface as usual.
 */
export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4, cooldown: ProviderCooldown = hackclubCooldown): LanguageModelV4 {
  const usePrimary = () => !cooldown.active();
  const fail = (err: unknown) => noteFailure(cooldown, err, primary.modelId);
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
        fail(err);
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
        fail(err);
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
          fail(err);
          return fallback.doStream(options);
        }
        if (next.done) break;
        const part = next.value;
        if (part.type === 'error' && !aborted(options)) {
          reader.cancel().catch(() => {});
          fail(part.error);
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

/**
 * Provider-neutral call settings: call sites pass `providerOptions: modelOptions({...})` and each provider tier
 * translates them (adaptCall), so one call works on Luna via OpenRouter and on Claude via Hack Club or Anthropic.
 */
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
export interface ModelSettings {
  /** Reasoning effort; unset = the model's default. Claude never goes below `low` (thinking stays on). */
  effort?: Effort | null;
  /** Ask for parallel tool calls (true) or at most one per step (false); unset = provider default. */
  parallelToolCalls?: boolean;
}
export const SETTINGS_KEY = 'smasnug';

export function modelOptions(s: ModelSettings): { [SETTINGS_KEY]: Record<string, any> } {
  return { [SETTINGS_KEY]: { ...(s.effort ? { effort: s.effort } : {}), ...(s.parallelToolCalls !== undefined ? { parallelToolCalls: s.parallelToolCalls } : {}) } };
}

/** Which request shape a tier speaks. */
export type Flavor = 'openrouter' | 'openrouter-claude' | 'anthropic';

/** Claude's lowest effort is `low`: `none` / `minimal` (reasoning off on Luna) map to it. */
export function claudeEffort(effort: Effort): 'low' | 'medium' | 'high' {
  return effort === 'none' || effort === 'minimal' ? 'low' : effort;
}

/** Thinking counts towards Claude's output limit: short caps (gate verdicts, titles) leave room for it. */
export const CLAUDE_MIN_OUTPUT_TOKENS = 4096;

const CACHE = { type: 'ephemeral' } as const;

/**
 * Translates neutral settings into one tier's provider options, and adapts the call for Claude:
 *  - effort ≥ low with adaptive thinking; sampling parameters dropped (Claude 5.5 rejects them);
 *  - `toolChoice: 'required'` → 'auto': a forced tool call skips thinking (Haiku) or is a 400 (Sonnet 5.5); the front
 *    agent's plain-text nudge (turn-end.ts) covers a step without a tool call;
 *  - prompt caching: breakpoints on the system prompt (covers the tools before it) and the last message, so each
 *    agent step reads the previous step's prefix from cache. The OpenRouter provider reads `anthropic.cacheControl` too;
 *  - Anthropic direct: a replayed thinking block whose history changed is dropped instead of failing the request.
 */
export function adaptCall(options: CallOptions, flavor: Flavor): CallOptions {
  const { [SETTINGS_KEY]: neutral, ...rest } = (options.providerOptions ?? {}) as Record<string, any>;
  const s = (neutral ?? {}) as { effort?: Effort; parallelToolCalls?: boolean };
  const claude = flavor !== 'openrouter';
  const providerOptions: Record<string, any> = { ...rest };
  if (flavor === 'anthropic') {
    providerOptions.anthropic = {
      thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
      ...(s.effort ? { effort: claudeEffort(s.effort) } : {}),
      ...(s.parallelToolCalls === false ? { disableParallelToolUse: true } : {}),
      ...rest.anthropic,
    };
  } else {
    const effort = s.effort ? (claude ? claudeEffort(s.effort) : s.effort) : undefined;
    providerOptions.openrouter = {
      ...(effort ? { reasoning: { effort } } : {}),
      usage: { include: true },
      ...(s.parallelToolCalls !== undefined ? { parallel_tool_calls: s.parallelToolCalls } : {}),
      ...rest.openrouter,
    };
  }
  if (!claude) return { ...options, providerOptions };

  const prompt = options.prompt.map((m, i, all) => {
    const mark = (m.role === 'system' && i === 0) || i === all.length - 1;
    return mark ? ({ ...m, providerOptions: { ...m.providerOptions, anthropic: { ...m.providerOptions?.anthropic, cacheControl: CACHE } } } as typeof m) : m;
  });
  const { temperature: _t, topP: _p, topK: _k, ...base } = options;
  return {
    ...base,
    prompt,
    providerOptions,
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: Math.max(options.maxOutputTokens, CLAUDE_MIN_OUTPUT_TOKENS) } : {}),
    ...(options.toolChoice?.type === 'required' ? { toolChoice: { type: 'auto' } } : {}),
  };
}

/** A model whose calls go through adaptCall for its tier. */
export function adapted(model: LanguageModelV4, flavor: Flavor): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(adaptCall(options, flavor)),
    doStream: (options) => model.doStream(adaptCall(options, flavor)),
  };
}

/**
 * Chat model for a role. Claude ids: Hack Club (free daily budget) → Anthropic API (monthly credit) → MODEL_LUNA on
 * OpenRouter (paid, so the cheaper model). Other ids: Hack Club → OpenRouter, same model. Unconfigured tiers are
 * skipped. Pass settings via `providerOptions: modelOptions({...})`.
 */
export function chatModel(modelId: string): LanguageModelV4 {
  if (!isClaude(modelId)) {
    const fallback = adapted(openrouter(modelId), 'openrouter');
    return hackclub ? withFallback(adapted(hackclub(modelId), 'openrouter'), fallback, hackclubCooldown) : fallback;
  }
  let model = adapted(openrouter(env.MODEL_LUNA), 'openrouter');
  if (anthropic) model = withFallback(adapted(anthropic(anthropicClaudeId(modelId)), 'anthropic'), model, anthropicCooldown);
  if (hackclub) model = withFallback(adapted(hackclub(openrouterClaudeId(modelId)), 'openrouter-claude'), model, hackclubCooldown);
  return model;
}

/** Test hook. */
export function resetProviderCooldown(): void {
  hackclubCooldown.reset();
  anthropicCooldown.reset();
}
