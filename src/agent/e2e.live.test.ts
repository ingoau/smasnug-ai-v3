/**
 * End-to-end (LIVE=1): real pipeline scheduling + thread-run, real context rendering, real tools, real OpenRouter,
 * SLACK_FAKE Slack. A mention spawns a subagent, the run completes, the synthesis turn streams below the collapsed card.
 *   LIVE=1 pnpm vitest run src/agent/e2e.live.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';

const LIVE = process.env.LIVE === '1';
if (LIVE) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  process.env.SLACK_FAKE = '1';
  process.env.LOG_LEVEL ??= 'warn';
}

const job = <T>(data: T) => ({ data, id: 'test' }) as unknown as Job<T>;

describe.skipIf(!LIVE)('agent e2e through the pipeline (LIVE)', () => {
  afterAll(async () => {
    if (!LIVE) return;
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    for (const q of [QUEUE.subagentRun, QUEUE.cardRender, QUEUE.threadRun]) await queue(q).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    const { redis } = await import('../core/redis.js');
    const { sql } = await import('../db/index.js');
    await redis.quit();
    await sql.end();
  });

  it('mention → spawn → run → synthesis', async () => {
    await import('../tools/index.js');
    await import('./register.js');
    await import('../features/register.js');
    const { sql } = await import('../db/index.js');
    const { fakeCalls } = await import('../core/slack-fake.js');
    const { redis } = await import('../core/redis.js');
    const scheduler = await import('../pipeline/scheduler.js');
    const { processThreadRun } = await import('../pipeline/thread-run.js');
    const { processSubagentRun } = await import('./child.js');

    await redis.del('slack:fake:calls');
    const channel = 'C_E2E';
    const root = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const threadId = `${channel}:${root}`;
    const user = `U_E2E${Date.now().toString(36).toUpperCase()}`;
    await sql`insert into threads (id, channel_id, thread_ts, engaged, last_addressed_at) values (${threadId}, ${channel}, ${root}, true, now())`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${root}, ${threadId}, ${user},
      ${'<@UBOT> please hand this to a background subagent: list 3 fun facts about octopuses. Delegate it, don\'t answer yourself.'})`;
    await scheduler.scheduleMessages(threadId, user, [root], true);
    await processThreadRun(job({ threadId }));

    const runs = await sql<any[]>`select * from runs where thread_id = ${threadId} order by id`;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const r of runs) await processSubagentRun(Number(r.id));
    const synth = await sql<any[]>`select * from turns where thread_id = ${threadId} and kind = 'synthesis'`;
    expect(synth).toHaveLength(1);
    await processThreadRun(job({ threadId }));

    const turns = await sql<any[]>`select kind, status from turns where thread_id = ${threadId} order by id`;
    expect(turns.every((t) => t.status === 'done')).toBe(true);
    const calls = await fakeCalls();
    const hasPlan = (c: any) => c.args.blocks?.some((b: any) => b.type === 'plan');
    const cardIdx = calls.findIndex((c) => (c.method === 'chat.postMessage' || c.method === 'chat.update') && hasPlan(c) && c.args.channel === channel);
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    const replied = (await sql<any[]>`select 1 from thread_events where thread_id = ${threadId} and type = 'reply' and (payload->>'turnId')::bigint = (select min(id) from turns where thread_id = ${threadId})`).length > 0;
    // With a reply in the spawning turn, the card is attached to it (chat.update), never posted separately.
    if (replied) expect(calls[cardIdx]!.method).toBe('chat.update');
    const streamIdx = calls.findIndex((c, i) => i > cardIdx && c.method === 'chat.startStream');
    expect(streamIdx).toBeGreaterThan(cardIdx);
    const [card] = await sql<any[]>`select * from cards where thread_id = ${threadId}`;
    expect(card.frozen).toBe(true);
    const lastUpdate = calls.filter((c) => c.method === 'chat.update' && c.args.ts === card.messageTs).at(-1);
    expect(lastUpdate!.args.blocks.some((b: any) => b.type === 'actions')).toBe(false);
    // eslint-disable-next-line no-console
    // Frozen after the synthesis: collapsed to one line ("✓ *Title* · ran N subagents"), never deleted.
    expect(lastUpdate!.args.blocks[0].type).toBe('context');
    console.log('e2e:', calls.map((c) => c.method).join(' → '), '| in reply:', replied, '| card:', lastUpdate!.args.blocks[0].elements[0].text);
  }, 180_000);
});
