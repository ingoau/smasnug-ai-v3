/**
 * A subagent run whose slack_search can't get a slot soon (fake Slack, mock model) against the test Postgres + Redis:
 * the search is queued and returns at once, and when the model tries to finish while it's pending, the run waits for
 * it, adds the results and has the report written again.
 * Run: INTEGRATION=1 pnpm vitest run src/agent/child-deferred.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
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
const textStep = (text: string) => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
];

describe.skipIf(!INTEGRATION)('subagent run with a queued (background) Slack search', () => {
  let sql: typeof import('../db/index.js').sql;
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  const channel = `CDEF${r}`;
  const PUB = `CDEFPUB${r}`;
  const rootTs = '1790000000.000100';
  const threadId = `${channel}:${rootTs}`;
  const query = `deferred${r} lore`;
  let searches = 0;
  let removeHandler = () => {};

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs}) on conflict do nothing`;
    const { addFakeHandler } = await import('../core/slack-fake.js');
    const { SlackBusyError } = await import('../core/slack.js');
    removeHandler = addFakeHandler(async (method, args) => {
      if (method === 'conversations.info' && args.channel === PUB) return { ok: true, channel: { id: PUB, name: 'lore', is_channel: true, is_private: false } };
      if (method !== 'search.messages' || args.query !== query) return undefined;
      // The quick try finds the limiter busy; the queued search gets its slot a little later.
      if (searches++ === 0) throw new SlackBusyError('slack:rl:user:search.messages', 20_000);
      await new Promise((res) => setTimeout(res, 300));
      return {
        ok: true,
        messages: {
          matches: [{ channel: { id: PUB, name: 'lore', is_private: false }, user: 'U_LORE', ts: '1790000001.000100', text: 'the answer is 42', permalink: `https://x.slack.com/archives/${PUB}/p1790000001000100` }],
        },
      };
    });
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    removeHandler();
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    const { redis } = await import('../core/redis.js');
    await queue(QUEUE.subagentRun).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await sql`delete from threads where id = ${threadId}`;
    await redis.quit();
    await sql.end();
  });

  it('queues the search, waits for it before finishing, and has the report rewritten with it', async () => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const { simulateReadableStream } = await import('ai');
    const steps: any[][] = [
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 's1', toolName: 'slack_search', input: JSON.stringify({ query }) },
        { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
      ],
      // Tries to finish while the search is still queued.
      textStep('Nothing found yet.\nSUMMARY: nothing found'),
      textStep('The answer is 42.\nSUMMARY: the answer is 42'),
    ];
    let i = 0;
    h.model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: steps[Math.min(i++, steps.length - 1)]! }) as any }) });
    await import('../tools/index.js');
    const sub = await import('./subagents.js');
    const { processSubagentRun, BACKGROUND_RESULTS_HEADER } = await import('./child.js');

    const [t] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status) values (${threadId}, 'U_DEF', 'running') returning id`;
    const s = await sub.spawnSubagent({ threadId, turnId: Number(t!.id), ownerId: 'U_DEF', title: 'Lore', instructions: 'Find the answer' });
    await processSubagentRun(s.runId);

    const [run] = await sql<any[]>`select status, result from runs where id = ${s.runId}`;
    expect(run.status).toBe('complete');
    expect(run.result).toContain('The answer is 42.');
    expect(searches).toBe(2);
    expect(h.model.doStreamCalls).toHaveLength(3);
    // Step 2 saw the "queued" tool result, step 3 the results and the ask to rewrite the report.
    const second = JSON.stringify(h.model.doStreamCalls[1].prompt);
    expect(second).toContain('Queued as background search S1');
    const third = JSON.stringify(h.model.doStreamCalls[2].prompt);
    expect(third).toContain(BACKGROUND_RESULTS_HEADER);
    expect(third).toContain('[Background search S1:');
    expect(third).toContain('the answer is 42');
    expect(third).toContain("so it isn't final yet");

    const events = await sql<any[]>`select type, payload from thread_events where thread_id = ${threadId} and type in ('run_step', 'run_bg_wait') order by id`;
    expect(events.find((e) => e.type === 'run_step' && e.payload.step === 0)?.payload.deferredSearches).toBe(1);
    expect(events.find((e) => e.type === 'run_bg_wait')?.payload).toMatchObject({ runId: s.runId, delivered: true });
  });
});
