/**
 * A subagent run that uses web_search (Exa mocked via fetch, mock model) against the test Postgres + Redis: the card
 * progress line names the search, Exa result URLs land in runs.sources, the results reach the model.
 * Run: INTEGRATION=1 pnpm vitest run src/agent/child-websearch.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  // Before .env: the real Exa key must never be used here (fetch is stubbed anyway).
  process.env.EXA_API_KEY = 'test-exa';
  if (process.env.INTEGRATION === '1') {
    try {
      process.loadEnvFile('.env');
    } catch {}
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});

const h = vi.hoisted(() => ({ model: undefined as any }));
vi.mock('../models.js', async (orig) => ({ ...(await orig<typeof import('../models.js')>()), MODELS: { gate: 'mock', front: 'mock', child: 'mock-child' }, chatModel: () => h.model }));
vi.mock('../pipeline/scheduler.js', () => ({ requestTurn: async () => 1 }));
vi.mock('./cards.js', async (orig) => ({ ...(await orig<typeof import('./cards.js')>()), scheduleCardRender: async () => {} }));

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

describe.skipIf(!INTEGRATION)('subagent run with web_search (mock model, mocked Exa)', () => {
  let sql: typeof import('../db/index.js').sql;
  const channel = `CWEB${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const rootTs = '1790000000.000100';
  const threadId = `${channel}:${rootTs}`;
  const exa: any[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs}) on conflict do nothing`;
    globalThis.fetch = (async (url: any, init: any) => {
      if (!String(url).startsWith('https://api.exa.ai/')) return realFetch(url, init);
      exa.push(JSON.parse(init.body));
      return Response.json({
        results: [
          { title: 'Raspberry Pi Pico 2 W', url: 'https://example.com/pico?utm_source=x', publishedDate: '2026-09-02T00:00:00Z', text: 'The Pico 2 W costs $7.' },
          { title: 'Pico 2 W at a reseller', url: 'https://shop.example.org/pico-2-w', text: 'In stock: $7.20' },
        ],
        costDollars: { total: 0.012 },
      });
    }) as typeof fetch;
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    globalThis.fetch = realFetch;
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    const { redis } = await import('../core/redis.js');
    await queue(QUEUE.subagentRun).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await sql`delete from threads where id = ${threadId}`;
    await redis.quit();
    await sql.end();
  });

  it('progress, sources and results', async () => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const { simulateReadableStream } = await import('ai');
    const steps: any[][] = [
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'w1', toolName: 'web_search', input: JSON.stringify({ query: 'pico 2 w price', mode: 'deep', full_text: true, num_results: 2 }) },
        { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
      ],
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'The Pico 2 W costs $7.\nSUMMARY: Pico 2 W costs $7' },
        { type: 'text-end', id: 't' },
        { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
      ],
    ];
    let i = 0;
    h.model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: steps[Math.min(i++, steps.length - 1)]! }) as any }) });
    await import('../tools/index.js');
    const sub = await import('./subagents.js');
    const { processSubagentRun } = await import('./child.js');

    const [t] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status) values (${threadId}, 'U_WEB', 'running') returning id`;
    const s = await sub.spawnSubagent({ threadId, turnId: Number(t!.id), ownerId: 'U_WEB', title: 'Pico price', instructions: 'Find the Pico 2 W price' });
    await processSubagentRun(s.runId);

    const [run] = await sql<any[]>`select status, model, result, sources from runs where id = ${s.runId}`;
    expect(run.status).toBe('complete');
    expect(run.model).toBe('mock-child');
    expect(run.result).toContain('$7');
    expect(run.sources.map((x: any) => x.url)).toEqual(['https://example.com/pico', 'https://shop.example.org/pico-2-w']);
    expect(run.sources[0].title).toBe('Raspberry Pi Pico 2 W');

    expect(exa).toEqual([{ query: 'pico 2 w price', type: 'deep-lite', numResults: 2, contents: { text: { maxCharacters: 8000 } } }]);
    const progress = await sql<any[]>`select payload from thread_events where thread_id = ${threadId} and type = 'run_progress'`;
    expect(progress.map((p) => p.payload.details)).toContain('Searching the web for “pico 2 w price”');
    const second = JSON.stringify(h.model.doStreamCalls[1].prompt);
    expect(second).toContain('The Pico 2 W costs $7.');
    expect(second).toContain('untrusted_content');
    expect(second).not.toContain('"sources"');
  });
});
