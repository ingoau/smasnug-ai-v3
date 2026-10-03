import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelV4 } from '@openrouter/ai-sdk-provider';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});

const { withFallback, resetProviderCooldown } = await import('./models.js');

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

  it('rethrows when the call was aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const fb = vi.fn();
    const m = withFallback(fake('hc', { doGenerate: async () => { throw new Error('aborted'); } }), fake('or', { doGenerate: fb }));
    await expect(m.doGenerate({ ...opts, abortSignal: ac.signal })).rejects.toThrow('aborted');
    expect(fb).not.toHaveBeenCalled();
  });
});
