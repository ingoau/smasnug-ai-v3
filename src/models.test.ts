import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelV4 } from '@openrouter/ai-sdk-provider';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});

const {
  withFallback,
  resetProviderCooldown,
  adaptCall,
  modelOptions,
  isClaude,
  openrouterClaudeId,
  anthropicClaudeId,
  claudeEffort,
  CLAUDE_MIN_OUTPUT_TOKENS,
  modelDisplayName,
  classifyProviderFailure,
  classifyProviderError,
  errorStatus,
  errorText,
  nextUtcMidnight,
  ProviderCooldown,
} = await import('./models.js');
const { log } = await import('./log.js');

type Part = { type: string; [k: string]: unknown };
const stream = (parts: Part[]) =>
  new ReadableStream<any>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
const fake = (name: string, impl: Partial<Pick<LanguageModelV4, 'doGenerate' | 'doStream'>>) =>
  ({ specificationVersion: 'v4', provider: name, modelId: 'm', supportedUrls: {}, ...impl }) as LanguageModelV4;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
const read = async (s: ReadableStream<any>) => {
  const out: Part[] = [];
  for await (const p of s as any) out.push(p);
  return out.map((p) => p.type + (p.delta ? `:${p.delta}` : ''));
};
const ok = (from: string) => ({ stream: stream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: from }, { type: 'finish' }]) });
const opts = { prompt: [] } as any;
const HC_BUDGET_MSG = 'Request would exceed the OpenRouter top-up wait spending limit for today';
/** Shaped like an AI SDK APICallError from the OpenRouter provider (message from the parsed body). */
const hcBudget429 = () =>
  Object.assign(new Error(HC_BUDGET_MSG), {
    statusCode: 429,
    responseBody: JSON.stringify({ error: { code: 429, message: HC_BUDGET_MSG } }),
    data: { error: { code: 429, message: HC_BUDGET_MSG } },
  });

describe('classifyProviderFailure', () => {
  const now = Date.parse('2026-10-07T21:30:00Z');
  const midnight = Date.parse('2026-10-08T00:00:00Z');

  it('402 and spending-limit 429s are budget: skip until UTC midnight', () => {
    expect(nextUtcMidnight(now)).toBe(midnight);
    expect(classifyProviderFailure({ status: 402 }, now)).toMatchObject({ kind: 'budget', until: midnight });
    expect(classifyProviderFailure({ status: 429, text: HC_BUDGET_MSG, retryAfterSec: 5 }, now)).toMatchObject({ kind: 'budget', until: midnight });
    for (const text of ['Insufficient credits', 'daily budget exceeded', 'key spending_limit reached', 'please top up']) {
      expect(classifyProviderFailure({ status: 429, text }, now).kind).toBe('budget');
    }
    // A status-less stream error that says so, too; a 5xx never is.
    expect(classifyProviderFailure({ text: HC_BUDGET_MSG }, now).kind).toBe('budget');
    expect(classifyProviderFailure({ status: 503, text: HC_BUDGET_MSG }, now).kind).toBe('other');
  });

  it('other 429s are short rate-limit cooldowns', () => {
    for (const text of ['Rate limit exceeded', 'Too many requests', 'quota exceeded for requests per minute', '']) {
      expect(classifyProviderFailure({ status: 429, text }, now)).toMatchObject({ kind: 'rate_limit', until: now + 60_000 });
    }
    expect(classifyProviderFailure({ status: 429, retryAfterSec: 7 }, now).until).toBe(now + 7_000);
  });

  it('401/403 are auth cooldowns; anything else none', () => {
    expect(classifyProviderFailure({ status: 403 }, now)).toMatchObject({ kind: 'auth', until: now + 600_000 });
    expect(classifyProviderFailure({ status: 500 }, now)).toMatchObject({ kind: 'other', until: now });
    expect(classifyProviderFailure({}, now)).toMatchObject({ kind: 'other', until: now });
  });

  it('reads status and text from APICallErrors and OpenRouter error objects', () => {
    expect(errorStatus(hcBudget429())).toBe(429);
    expect(errorStatus({ code: 429, message: 'x' })).toBe(429);
    expect(errorStatus({ code: 'rate_limited' })).toBeUndefined();
    // The message may only be in the body (e.g. an empty statusText message).
    const bodyOnly = Object.assign(new Error('Too Many Requests'), { statusCode: 429, responseBody: `{"error":{"message":"${HC_BUDGET_MSG}"}}` });
    expect(errorText(bodyOnly)).toContain('spending limit');
    expect(classifyProviderError(bodyOnly, now)).toMatchObject({ kind: 'budget', until: midnight });
    expect(classifyProviderError({ data: { error: { code: 429, message: 'Provider returned error', metadata: { raw: HC_BUDGET_MSG } } } }, now).kind).toBe('budget');
    const retry = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429, responseHeaders: { 'retry-after': '3' } });
    expect(classifyProviderError(retry, now)).toMatchObject({ kind: 'rate_limit', until: now + 3_000 });
    expect(classifyProviderError(null, now).kind).toBe('other');
  });

  it('ProviderCooldown only extends, and logs a budget skip once per window', () => {
    const c = new ProviderCooldown('test');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined as any);
    try {
      const budget = classifyProviderFailure({ status: 429, text: HC_BUDGET_MSG }, now);
      c.note(budget, {}, now);
      c.note(budget, {}, now);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ reason: expect.stringMatching(/spending limit/), skipUntil: '2026-10-08T00:00:00.000Z' });
      c.note(classifyProviderFailure({ status: 429 }, now), {}, now);
      expect(c.skipUntil).toBe(midnight);
      expect(c.active(midnight - 1)).toBe(true);
      expect(c.active(midnight)).toBe(false);
      c.reset();
      expect(c.active(now)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

beforeEach(() => resetProviderCooldown());

describe('withFallback', () => {
  it('uses the primary when it works', async () => {
    const fb = vi.fn();
    const m = withFallback(fake('hc', { doStream: async () => ok('hc') as any }), fake('or', { doStream: fb }));
    expect(await read((await m.doStream(opts)).stream)).toEqual(['stream-start', 'text-start', 'text-delta:hc', 'finish']);
    expect(fb).not.toHaveBeenCalled();
  });

  it('falls back when the primary throws or errors before any output', async () => {
    const fb = fake('or', { doStream: async () => ok('or') as any, doGenerate: async () => ({ content: [{ type: 'text', text: 'or' }] }) as any });
    const thrown = withFallback(fake('hc', { doStream: async () => { throw httpError(500); } }), fb);
    expect(await read((await thrown.doStream(opts)).stream)).toContain('text-delta:or');
    const errPart = withFallback(fake('hc', { doStream: async () => ({ stream: stream([{ type: 'stream-start' }, { type: 'error', error: httpError(503) }]) }) as any }), fb);
    expect(await read((await errPart.doStream(opts)).stream)).toContain('text-delta:or');
    const gen = withFallback(fake('hc', { doGenerate: async () => { throw httpError(500); } }), fb);
    expect((await gen.doGenerate(opts)).content).toEqual([{ type: 'text', text: 'or' }]);
  });

  it('does not fall back once output has streamed', async () => {
    const fb = vi.fn();
    const m = withFallback(
      fake('hc', { doStream: async () => ({ stream: stream([{ type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'a' }, { type: 'error', error: 'x' }]) }) as any }),
      fake('or', { doStream: fb }),
    );
    expect(await read((await m.doStream(opts)).stream)).toEqual(['text-start', 'text-delta:a', 'error']);
    expect(fb).not.toHaveBeenCalled();
  });

  it('skips the primary after it runs out of daily budget (402)', async () => {
    const primary = vi.fn(async () => { throw httpError(402); });
    const m = withFallback(fake('hc', { doGenerate: primary }), fake('or', { doGenerate: async () => ({ content: [] }) as any }));
    await m.doGenerate(opts);
    await m.doGenerate(opts);
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('skips the primary until UTC midnight after a spending-limit 429, but retries soon after a plain 429', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-07T21:30:00Z'));
      const fb = fake('or', { doGenerate: async () => ({ content: [] }) as any });
      const budget = vi.fn(async () => { throw hcBudget429(); });
      const m = withFallback(fake('hc', { doGenerate: budget }), fb);
      await m.doGenerate(opts);
      vi.setSystemTime(new Date('2026-10-07T23:59:00Z'));
      await m.doGenerate(opts);
      expect(budget).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-08T00:00:01Z'));
      await m.doGenerate(opts);
      expect(budget).toHaveBeenCalledTimes(2);

      resetProviderCooldown();
      const limited = vi.fn(async () => { throw httpError(429); });
      const r = withFallback(fake('hc', { doGenerate: limited }), fb);
      await r.doGenerate(opts);
      await r.doGenerate(opts);
      expect(limited).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 61_000);
      await r.doGenerate(opts);
      expect(limited).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a spending-limit stream error part like a 402', async () => {
    const primary = vi.fn(async () => ({ stream: stream([{ type: 'stream-start' }, { type: 'error', error: { code: 429, message: HC_BUDGET_MSG } }]) }) as any);
    const m = withFallback(fake('hc', { doStream: primary }), fake('or', { doStream: async () => ok('or') as any }));
    await m.doStream(opts);
    await m.doStream(opts);
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the call was aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const fb = vi.fn();
    const m = withFallback(fake('hc', { doGenerate: async () => { throw new Error('aborted'); } }), fake('or', { doGenerate: fb }));
    await expect(m.doGenerate({ ...opts, abortSignal: ac.signal })).rejects.toThrow('aborted');
    expect(fb).not.toHaveBeenCalled();
  });
});

describe('Claude model ids', () => {
  it('maps between Anthropic and OpenRouter ids', () => {
    expect(isClaude('claude-haiku-5-5')).toBe(true);
    expect(isClaude('anthropic/claude-sonnet-5.5')).toBe(true);
    expect(isClaude('openai/gpt-6-luna')).toBe(false);
    expect(openrouterClaudeId('claude-haiku-5-5')).toBe('anthropic/claude-haiku-5.5');
    expect(openrouterClaudeId('claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(openrouterClaudeId('anthropic/claude-sonnet-5.5')).toBe('anthropic/claude-sonnet-5.5');
    expect(anthropicClaudeId('anthropic/claude-sonnet-5.5')).toBe('claude-sonnet-5-5');
    expect(anthropicClaudeId('claude-haiku-5-5')).toBe('claude-haiku-5-5');
  });

  it('Anthropic budget errors (no credit, console spend limit) skip until midnight', () => {
    const now = Date.parse('2026-10-07T21:30:00Z');
    for (const text of ['Your credit balance is too low to access the Anthropic API.', 'You have reached your specified API usage limits. You will regain access on 2026-11-01.']) {
      expect(classifyProviderFailure({ status: 400, text }, now).kind).toBe('budget');
    }
  });
});

describe('adaptCall', () => {
  const call = (extra: Record<string, unknown> = {}) =>
    ({
      prompt: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
      ],
      providerOptions: modelOptions({ effort: 'none', parallelToolCalls: true }),
      toolChoice: { type: 'required' },
      temperature: 0,
      maxOutputTokens: 16,
      ...extra,
    }) as any;

  it('Luna on OpenRouter: the settings as before, the call otherwise untouched', () => {
    const out = adaptCall(call(), 'openrouter');
    expect(out.providerOptions).toEqual({ openrouter: { reasoning: { effort: 'none' }, usage: { include: true }, parallel_tool_calls: true } });
    expect(out).toMatchObject({ toolChoice: { type: 'required' }, temperature: 0, maxOutputTokens: 16 });
    expect(out.prompt[0]!.providerOptions).toBeUndefined();
  });

  it('Claude via Hack Club / OpenRouter: effort at least low, no forced tools or sampling, room for thinking, cache breakpoints', () => {
    const out = adaptCall(call(), 'openrouter-claude');
    expect(out.providerOptions).toEqual({ openrouter: { reasoning: { effort: 'low' }, usage: { include: true }, parallel_tool_calls: true } });
    expect(out.toolChoice).toEqual({ type: 'auto' });
    expect(out.temperature).toBeUndefined();
    expect(out.maxOutputTokens).toBe(CLAUDE_MIN_OUTPUT_TOKENS);
    expect(out.prompt.map((m: any) => m.providerOptions?.anthropic?.cacheControl?.type)).toEqual(['ephemeral', undefined, undefined]);
    expect((out.prompt[2] as any).content[0].providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('Claude direct: anthropic options with adaptive thinking that tolerates edited history', () => {
    const out = adaptCall(call({ providerOptions: modelOptions({ effort: 'medium', parallelToolCalls: false }) }), 'anthropic');
    expect(out.providerOptions).toEqual({
      anthropic: { thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } }, effort: 'medium', disableParallelToolUse: true },
    });
    expect(adaptCall(call({ providerOptions: undefined, maxOutputTokens: 9000 }), 'anthropic').maxOutputTokens).toBe(9000);
    expect(claudeEffort('minimal')).toBe('low');
    expect(claudeEffort('high')).toBe('high');
  });
});

describe('provider chain', () => {
  it('each tier falls back to the next with its own cooldown', async () => {
    const hcCooldown = new ProviderCooldown('hc');
    const anCooldown = new ProviderCooldown('an');
    const hc = vi.fn(async () => { throw httpError(402); });
    const an = vi.fn(async () => { throw Object.assign(new Error('Your credit balance is too low'), { statusCode: 400 }); });
    const or = vi.fn(async () => ({ content: [{ type: 'text', text: 'luna' }] }) as any);
    const m = withFallback(fake('hc', { doGenerate: hc }), withFallback(fake('an', { doGenerate: an }), fake('or', { doGenerate: or }), anCooldown), hcCooldown);
    expect((await m.doGenerate(opts)).content).toEqual([{ type: 'text', text: 'luna' }]);
    await m.doGenerate(opts);
    expect([hc.mock.calls.length, an.mock.calls.length, or.mock.calls.length]).toEqual([1, 1, 2]);
    expect(hcCooldown.active() && anCooldown.active()).toBe(true);
  });
});

describe('adaptCall cache breakpoints', () => {
  it('marks only the last part of the last message (a tool message after parallel calls stays at one breakpoint)', () => {
    const results = [1, 2, 3, 4, 5].map((n) => ({ type: 'tool-result', toolCallId: `c${n}`, toolName: 't', output: { type: 'text', value: 'ok' } }));
    const out = adaptCall(
      {
        prompt: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: {} }] },
          { role: 'tool', content: results },
        ],
        providerOptions: modelOptions({}),
      } as any,
      'openrouter-claude',
    );
    const marks = JSON.stringify(out.prompt).match(/"cacheControl"/g) ?? [];
    expect(marks).toHaveLength(2);
    expect((out.prompt[3] as any).providerOptions).toBeUndefined();
    expect((out.prompt[3] as any).content.map((p: any) => !!p.providerOptions?.anthropic?.cacheControl)).toEqual([false, false, false, false, true]);
  });

  it('never marks a thinking block', () => {
    const out = adaptCall({ prompt: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'reasoning', text: '' }] }] } as any, 'anthropic');
    expect((out.prompt[0] as any).content.map((p: any) => !!p.providerOptions?.anthropic?.cacheControl)).toEqual([true, false]);
  });
});

describe('modelDisplayName', () => {
  it('names the models for the prompt', () => {
    expect(modelDisplayName('claude-haiku-5-5')).toBe('Claude Haiku 5.5');
    expect(modelDisplayName('anthropic/claude-sonnet-5.5')).toBe('Claude Sonnet 5.5');
    expect(modelDisplayName('claude-opus-5')).toBe('Claude Opus 5');
    expect(modelDisplayName('openai/gpt-6-luna')).toBe('GPT-6 Luna');
    expect(modelDisplayName('mock')).toBe('mock');
  });
});
