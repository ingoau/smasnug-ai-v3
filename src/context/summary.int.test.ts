/**
 * Rolling thread summary job against the test Postgres/Redis with a mock model: the covered ts advances, each update
 * reads only the newly dropped replies, repeated jobs are no-ops, two workers can't race, enqueueing is deduped by
 * (thread, target), and retention drops a summary whose replies were deleted.
 *   INTEGRATION=1 pnpm vitest run src/context/summary.int.test.ts
 */
import '../tools/test-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';

const h = vi.hoisted(() => ({
  prompts: [] as string[],
  n: 0,
  /** Runs inside the model call (e.g. to simulate a concurrent writer); may delay. */
  during: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../config.js', async (orig) => {
  const o = await orig<typeof import('../config.js')>();
  // Small batches so chunking (several model calls for one target) is exercised.
  return { ...o, limits: { ...o.limits, threadSummaryChunkTokens: 100 } };
});
vi.mock('../models.js', async (orig) => {
  const { MockLanguageModelV4 } = await import('ai/test');
  return {
    ...(await orig<typeof import('../models.js')>()),
    chatModel: () =>
      new MockLanguageModelV4({
        doGenerate: async (opts: any) => {
          h.prompts.push(JSON.stringify(opts.prompt));
          await h.during?.();
          h.n++;
          return {
            content: [{ type: 'text', text: `SUMMARY v${h.n}` }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
            warnings: [],
          } as any;
        },
      }),
  };
});

describe.skipIf(!INTEGRATION)('thread summary job', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let queues: typeof import('../core/queues.js');
  let S: typeof import('./summary.js');
  let runRetention: typeof import('../features/retention.js').runRetention;
  const loadThreadSummary = (id: string) => S.loadThreadSummary(id);
  const processThreadSummary = (job: { threadId: string; targetTs: string }) => S.processThreadSummary(job);

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    queues = await import('../core/queues.js');
    S = await import('./summary.js');
    ({ runRetention } = await import('../features/retention.js'));
  });

  const channel = `CSUM${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const base = 1790000000;
  const ts = (i: number) => `${base + i}.000100`;
  let threadId = '';
  let seq = 0;

  async function makeThread(replies: number) {
    const root = `${base + 1000 * ++seq}.000100`;
    threadId = `${channel}:${root}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${root})`;
    const rows = [
      { channel_id: channel, ts: root, thread_id: threadId, user_id: 'U0SAM', text: 'where should we hold the jam?' },
      ...Array.from({ length: replies }, (_, i) => ({ channel_id: channel, ts: rts(root, i + 1), thread_id: threadId, user_id: i % 2 ? 'U0KAI' : 'U0SAM', text: `reply ${i + 1}` })),
    ];
    await sql`insert into messages ${sql(rows, 'channel_id', 'ts', 'thread_id', 'user_id', 'text')}`;
    return root;
  }
  const rts = (root: string, i: number) => `${Number(root.split('.')[0]) + i}.000100`;

  beforeEach(() => {
    h.prompts = [];
    h.during = undefined;
  });

  afterAll(async () => {
    await sql`delete from threads where channel_id = ${channel}`;
    await sql`delete from messages where channel_id = ${channel}`;
    await queues.closeQueues();
    await sql.end();
    redis.disconnect();
  });

  it('folds in the dropped replies, then only the newly dropped ones; covered ts advances; repeats are no-ops', async () => {
    const root = await makeThread(12);
    const first = await processThreadSummary({ threadId, targetTs: rts(root, 4) });
    expect(first.calls).toBe(1);
    expect(h.prompts[0]).toContain('reply 1');
    expect(h.prompts[0]).toContain('reply 4');
    expect(h.prompts[0]).not.toContain('reply 5');
    expect(h.prompts[0]).toContain('where should we hold the jam?'); // parent as context
    expect(h.prompts[0]).toContain('There is no previous summary yet');
    let row = await loadThreadSummary(threadId);
    expect(row).toMatchObject({ coveredTs: rts(root, 4), coveredCount: 4 });
    const v1 = row!.summary;

    // Same target again: nothing to do.
    expect((await processThreadSummary({ threadId, targetTs: rts(root, 4) })).calls).toBe(0);
    expect(await loadThreadSummary(threadId)).toMatchObject({ summary: v1, coveredTs: rts(root, 4) });

    // Next target: previous summary + only replies 5..6.
    h.prompts = [];
    await processThreadSummary({ threadId, targetTs: rts(root, 6) });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(v1);
    expect(h.prompts[0]).toContain('reply 5');
    expect(h.prompts[0]).toContain('reply 6');
    expect(h.prompts[0]).not.toMatch(/reply [1-4]\b/);
    row = await loadThreadSummary(threadId);
    expect(row).toMatchObject({ coveredTs: rts(root, 6), coveredCount: 6 });
    const [usage] = await sql<any[]>`select updates, input_tokens, output_tokens, model from thread_summaries where thread_id = ${threadId}`;
    expect(usage).toMatchObject({ updates: 2, model: expect.any(String) });
    expect(Number(usage.inputTokens)).toBe(200);
  });

  it('a long stretch is folded in over several calls, oldest first, each building on the last', async () => {
    const root = await makeThread(40);
    const res = await processThreadSummary({ threadId, targetTs: rts(root, 40) });
    expect(res.calls).toBeGreaterThan(1);
    // Every later batch starts from the previous call's summary and never re-reads earlier replies.
    for (let i = 1; i < h.prompts.length; i++) expect(h.prompts[i]).toContain('<previous_summary>');
    expect(h.prompts.at(-1)).toContain('reply 40');
    expect(h.prompts.at(-1)).not.toMatch(/reply 1\\n/);
    expect(await loadThreadSummary(threadId)).toMatchObject({ coveredTs: rts(root, 40), coveredCount: 40 });
  });

  it('two workers on one thread: the second backs off (lock); a concurrent writer wins over a stale update', async () => {
    const root = await makeThread(10);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.during = () => gate;
    const a = processThreadSummary({ threadId, targetTs: rts(root, 3) });
    await vi.waitFor(() => expect(h.prompts.length).toBe(1));
    await expect(processThreadSummary({ threadId, targetTs: rts(root, 5) })).rejects.toBeInstanceOf(S.SummaryBusy);
    release();
    await a;
    expect(await loadThreadSummary(threadId)).toMatchObject({ coveredTs: rts(root, 3) });

    // Lock lost / stolen while the model ran: someone else advanced the summary meanwhile. The stale write is dropped.
    h.during = async () => {
      await sql`update thread_summaries set summary = 'OTHER', covered_ts = ${rts(root, 8)} where thread_id = ${threadId}`;
    };
    await processThreadSummary({ threadId, targetTs: rts(root, 6) });
    expect(await loadThreadSummary(threadId)).toMatchObject({ summary: 'OTHER', coveredTs: rts(root, 8) });
    expect(await redis.exists(S.summaryLockKey(threadId))).toBe(0); // released
  });

  it('enqueueing is deduped per (thread, target)', async () => {
    const root = await makeThread(3);
    const q = queues.queue(queues.QUEUE.threadSummary);
    await S.requestThreadSummary(threadId, rts(root, 2));
    await S.requestThreadSummary(threadId, rts(root, 2));
    const job = await q.getJob(S.summaryJobId(threadId, rts(root, 2)));
    expect(job?.data).toEqual({ threadId, targetTs: rts(root, 2) });
    const waiting = (await q.getJobs(['waiting', 'delayed', 'prioritized'])).filter((j) => j.data.threadId === threadId);
    expect(waiting).toHaveLength(1);
    await job!.remove();
  });

  it('retention drops a summary when a reply it covers is deleted; a gone thread gets no summary', async () => {
    const root = await makeThread(4);
    await processThreadSummary({ threadId, targetTs: rts(root, 2) });
    expect(await loadThreadSummary(threadId)).not.toBeNull();
    await sql`update messages set deleted = true where channel_id = ${channel} and ts = ${rts(root, 1)}`;
    await runRetention();
    expect(await loadThreadSummary(threadId)).toBeNull();

    // A thread that's gone (retention cascades its messages away): no model call, no row.
    const gone = `${channel}:${ts(99_999)}`;
    expect((await processThreadSummary({ threadId: gone, targetTs: ts(100_000) })).calls).toBe(0);
    expect(await loadThreadSummary(gone)).toBeNull();
  });
});
