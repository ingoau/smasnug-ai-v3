/**
 * Subagent runs around a worker restart and the stale-run sweeper (mock model, test Postgres + Redis):
 * - a run left behind by the previous (dead) worker process is swept; a run the new process just started is not,
 *   neither while it runs nor after it finished with text cut in the middle of an emoji (a lone surrogate once made
 *   its final write fail, which left it 'running' with no loop until the sweeper called it "Worker stopped");
 * - a run whose final write keeps failing is finished on the spot instead of waiting for the sweeper.
 * Run: INTEGRATION=1 pnpm vitest run src/agent/run-restart.int.test.ts
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

const h = vi.hoisted(() => ({ model: undefined as any, failFinish: false }));
vi.mock('../models.js', async (orig) => ({ ...(await orig<typeof import('../models.js')>()), MODELS: { gate: 'mock', front: 'mock', child: 'mock-child' }, chatModel: () => h.model }));
vi.mock('../pipeline/scheduler.js', () => ({ requestTurn: async () => 1 }));
vi.mock('./subagents.js', async (orig) => {
  const real = await orig<typeof import('./subagents.js')>();
  return {
    ...real,
    finishRun: async (...args: Parameters<typeof real.finishRun>) => {
      if (h.failFinish) throw new Error('db write failed');
      return real.finishRun(...args);
    },
  };
});

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const HALF_EMOJI = '\ud83c'; // the first half of 🎮: text cut between the two halves

describe.skipIf(!INTEGRATION)('subagent runs across a worker restart and the stale-run sweeper', () => {
  let sql: typeof import('../db/index.js').sql;
  let sub: typeof import('./subagents.js');
  let child: typeof import('./child.js');
  let maint: typeof import('./maintenance.js');
  const channel = `CRST${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const rootTs = '1790000000.000100';
  const threadId = `${channel}:${rootTs}`;
  let release: () => void = () => {};

  /** A model that streams one answer once `release()` is called (or right away when not gated). */
  async function useModel(text: string, gated: boolean) {
    const { MockLanguageModelV4 } = await import('ai/test');
    const { simulateReadableStream } = await import('ai');
    const gate = gated ? new Promise<void>((r) => (release = r)) : Promise.resolve();
    h.model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: text },
              { type: 'text-end', id: 't' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
            ],
          }) as any,
        };
      },
    });
  }

  async function spawn(title: string) {
    const [t] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status) values (${threadId}, 'U_RST', 'running') returning id`;
    return sub.spawnSubagent({ threadId, turnId: Number(t!.id), ownerId: 'U_RST', title, instructions: `Look into ${title}` });
  }
  const runRow = async (id: number) => (await sql<{ status: string; error: string | null; result: string | null }[]>`select status, error, result from runs where id = ${id}`)[0]!;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    await import('../tools/index.js');
    sub = await import('./subagents.js');
    child = await import('./child.js');
    maint = await import('./maintenance.js');
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs}) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    const { redis } = await import('../core/redis.js');
    for (const q of [QUEUE.subagentRun, QUEUE.cardRender]) await queue(q).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await sql`delete from threads where id = ${threadId}`;
    await redis.quit();
    await sql.end();
  });

  it('after a restart: the dead process\'s run is swept, the fresh run is not (live, or finished with a cut emoji)', async () => {
    // Left behind by the previous worker process (killed without its shutdown hook): no heartbeat for 2 minutes.
    const dead = await spawn('left behind');
    await sql`update runs set status = 'running', worker_id = 'previous-host:1', started_at = now() - interval '3 minutes',
              heartbeat_at = now() - interval '2 minutes' where id = ${dead.runId}`;

    // The new process picks up a fresh run; its model call is still in flight when the sweeper runs.
    const fresh = await spawn('fresh');
    await useModel(`Found the jam: Run a Game Jam ${HALF_EMOJI}\nSUMMARY: Found the game jam ${HALF_EMOJI}`, true);
    const running = child.processSubagentRun(fresh.runId);
    for (let i = 0; i < 100 && (await runRow(fresh.runId)).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await runRow(fresh.runId)).status).toBe('running');

    await maint.sweepStaleRuns();
    expect(await runRow(dead.runId)).toMatchObject({ status: 'error', error: 'Worker stopped' });
    expect((await runRow(fresh.runId)).status).toBe('running');

    release();
    await running;
    const done = await runRow(fresh.runId);
    expect(done.status).toBe('complete');
    expect(done.result).toContain('Run a Game Jam');
    // The history (jsonb) was saved too: the cut emoji became U+FFFD instead of failing the write.
    const [sa] = await sql<{ history: any[] }[]>`select history from subagents where id = ${fresh.subagentId}`;
    expect(JSON.stringify(sa!.history)).toContain('�');
    await maint.sweepStaleRuns();
    expect((await runRow(fresh.runId)).status).toBe('complete');
  });

  it('a run whose final write keeps failing is finished at once (error), not left running for the sweeper', async () => {
    const s = await spawn('unlucky');
    await useModel('All done.\nSUMMARY: Done', false);
    h.failFinish = true;
    try {
      await child.processSubagentRun(s.runId);
    } finally {
      h.failFinish = false;
    }
    expect(await runRow(s.runId)).toMatchObject({ status: 'error', error: 'Error: db write failed' });
    const [sa] = await sql<{ status: string }[]>`select status from subagents where id = ${s.subagentId}`;
    expect(sa!.status).toBe('idle');
    await maint.sweepStaleRuns();
  });
});
