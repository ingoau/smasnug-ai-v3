/**
 * Multi-round workflow (LIVE=1): real pipeline + models, SLACK_FAKE Slack. A request that needs a list first and
 * then per-item research should run in rounds: round 1 finds the items, a summary turn starts parallel subagents
 * for them (cards linked via parent_card_id), and a later summary turn answers.
 *   LIVE=1 pnpm vitest run src/agent/workflow.live.test.ts
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

describe.skipIf(!LIVE)('multi-round subagent workflow (LIVE)', () => {
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

  it('list first, then parallel per-item subagents, then the answer', async () => {
    await import('../tools/index.js');
    await import('./register.js');
    await import('../features/register.js');
    const { sql } = await import('../db/index.js');
    const scheduler = await import('../pipeline/scheduler.js');
    const { processThreadRun } = await import('../pipeline/thread-run.js');
    const { processSubagentRun } = await import('./child.js');

    const channel = 'D_FLOW';
    const root = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const threadId = `${channel}:${root}`;
    const user = `U_FLOW${Date.now().toString(36).toUpperCase()}`;
    await sql`insert into threads (id, channel_id, thread_ts, is_dm, engaged, last_addressed_at) values (${threadId}, ${channel}, ${root}, true, true, now())`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${root}, ${threadId}, ${user},
      ${'first figure out which 3 dev boards beginners most commonly buy right now, then research each of those 3 in depth (current price, specs, pros and cons) and compare them. take your time'})`;
    await scheduler.scheduleMessages(threadId, user, [root], true);

    // Drive the pipeline: run turns, then queued subagent runs, until nothing is left (bounded).
    for (let round = 0; round < 6; round++) {
      await processThreadRun(job({ threadId }));
      const queued = await sql<{ id: number }[]>`select id from runs where thread_id = ${threadId} and status = 'queued' order by id`;
      if (!queued.length) {
        const pending = await sql`select 1 from turns where thread_id = ${threadId} and status = 'pending'`;
        if (!pending.length) break;
        continue;
      }
      await Promise.all(queued.map((r) => processSubagentRun(Number(r.id))));
    }

    const cards = await sql<{ id: number; parentCardId: number | null; runs: number }[]>`
      select c.id, c.parent_card_id, (select count(*)::int from runs r where r.card_id = c.id) as runs
      from cards c where c.thread_id = ${threadId} order by c.id`;
    const replies = await sql<{ payload: any }[]>`select payload from thread_events where thread_id = ${threadId} and type = 'reply' order by id`;
    // eslint-disable-next-line no-console
    console.log('workflow cards:', JSON.stringify(cards), 'replies:', replies.map((r) => String(r.payload.text ?? '').slice(0, 120)));

    // Either it ran in rounds (a later card started from a summary turn) or it parallelized up front.
    const multiRound = cards.some((c) => c.parentCardId != null);
    expect(multiRound || cards.some((c) => c.runs >= 3)).toBe(true);
    expect(cards.some((c) => c.runs >= 2)).toBe(true); // some round ran subagents in parallel
    const last = replies.at(-1)?.payload.text ?? '';
    expect(last.length).toBeGreaterThan(80); // ends with an answer
  }, 600_000);

  it('an explicitly staged request runs a second round from the summary turn', async () => {
    const { sql } = await import('../db/index.js');
    const scheduler = await import('../pipeline/scheduler.js');
    const { processThreadRun } = await import('../pipeline/thread-run.js');
    const { processSubagentRun } = await import('./child.js');
    const channel = 'D_FLOW2';
    const root = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const threadId = `${channel}:${root}`;
    const user = `U_FLOW${Date.now().toString(36).toUpperCase()}`;
    await sql`insert into threads (id, channel_id, thread_ts, is_dm, engaged, last_addressed_at) values (${threadId}, ${channel}, ${root}, true, true, now())`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${root}, ${threadId}, ${user},
      ${'two steps please. step 1: have a subagent find the three most recent major Node.js release lines. step 2: only once you know them, start one subagent per release to research its headline features, then compare. take your time'})`;
    await scheduler.scheduleMessages(threadId, user, [root], true);
    for (let round = 0; round < 8; round++) {
      await processThreadRun(job({ threadId }));
      const queued = await sql<{ id: number }[]>`select id from runs where thread_id = ${threadId} and status = 'queued' order by id`;
      if (!queued.length) {
        const pending = await sql`select 1 from turns where thread_id = ${threadId} and status = 'pending'`;
        if (!pending.length) break;
        continue;
      }
      await Promise.all(queued.map((r) => processSubagentRun(Number(r.id))));
    }
    const cards = await sql<{ id: number; parentCardId: number | null; runs: number }[]>`
      select c.id, c.parent_card_id, (select count(*)::int from runs r where r.card_id = c.id) as runs
      from cards c where c.thread_id = ${threadId} order by c.id`;
    // eslint-disable-next-line no-console
    console.log('staged cards:', JSON.stringify(cards));
    const second = cards.find((c) => c.parentCardId != null);
    expect(second).toBeTruthy();
    expect(second!.runs).toBeGreaterThanOrEqual(2);
    const synth = await sql`select 1 from turns where thread_id = ${threadId} and kind = 'synthesis'`;
    expect(synth.length).toBeGreaterThanOrEqual(2);
  }, 600_000);
});
