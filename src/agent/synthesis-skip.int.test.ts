/**
 * Results (synthesis) turns after cancellations, against the test Postgres + Redis (no model calls):
 * - a card whose runs were all cancelled gets no synthesis turn: it is finished (synthesized + frozen) instead, with a
 *   `synthesis_skipped` event, exactly once even when its runs end concurrently; while the turn that started it is
 *   still running it is left alone (that turn may spawn on it again) until the turn ends;
 * - a mixed card (some cancelled, some finished) still gets exactly one synthesis turn, and its context lists what
 *   happened since the round started (later messages, the cancel and the turn that did it).
 * Run: INTEGRATION=1 pnpm vitest run src/agent/synthesis-skip.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const h = vi.hoisted(() => ({ requested: [] as any[], titles: [] as unknown[][] }));
vi.mock('../pipeline/scheduler.js', () => ({
  requestTurn: async (opts: any) => {
    h.requested.push(opts);
    return 1;
  },
}));
vi.mock('./titles.js', () => ({ enqueueCardTitle: async (cardId: number, turnId: number) => void h.titles.push([cardId, turnId]) }));

describe.skipIf(!INTEGRATION)('synthesis after cancellations', () => {
  let sql: typeof import('../db/index.js').sql;
  let sub: typeof import('./subagents.js');
  let since: typeof import('./round-since.js');
  const channel = `CSKP${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const rootTs = '1790000000.000100';
  const threadId = `${channel}:${rootTs}`;

  async function newTurn(status: 'running' | 'done', messageTs: string[] = []) {
    const [t] = await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, status, message_ts, started_at, finished_at)
      values (${threadId}, 'U_SKP', ${status}, ${messageTs}, now(), ${status === 'done' ? sql`now()` : null})
      returning id`;
    return Number(t!.id);
  }
  const spawn = (turnId: number, title: string) => sub.spawnSubagent({ threadId, turnId, ownerId: 'U_SKP', title, instructions: `Look into ${title}` });
  const run = (s: { runId: number; subagentId: string; cardId: number }) => ({ id: s.runId, subagentId: s.subagentId, threadId, cardId: s.cardId });
  const card = async (id: number) => (await sql<{ synthesized: boolean; frozen: boolean }[]>`select synthesized, frozen from cards where id = ${id}`)[0]!;
  const events = (type: string, cardId: number) => sql<{ payload: any }[]>`
    select payload from thread_events where thread_id = ${threadId} and type = ${type} and payload->>'cardId' = ${String(cardId)}`;
  const forCard = (cardId: number) => h.requested.filter((r) => r.cardId === cardId);

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    sub = await import('./subagents.js');
    since = await import('./round-since.js');
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs}) on conflict do nothing`;
  });

  beforeEach(() => {
    h.requested = [];
    h.titles = [];
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

  it('all runs cancelled (finishing concurrently): no synthesis turn; the card is finished once, with an event and a title', async () => {
    const turn = await newTurn('done', ['1790000001.000100']);
    const a = await spawn(turn, 'Topic A');
    const b = await spawn(turn, 'Topic B');
    expect(b.cardId).toBe(a.cardId);
    await sql`update runs set status = 'running' where id in ${sql([a.runId, b.runId])}`;
    await sql`update cards set message_ts = '1790000001.000200' where id = ${a.cardId}`; // the card went out with the reply
    // The front agent cancels both (a later turn); the loops stop at their next step, at the same time.
    const later = await newTurn('done', ['1790000002.000100']);
    await sub.cancelSubagent({ threadId, subagentId: a.subagentId, actor: 'U_SKP', turnId: later });
    await sub.cancelSubagent({ threadId, subagentId: b.subagentId, actor: 'U_SKP', turnId: later });
    const res = await Promise.all([sub.finishRun(run(a), { status: 'cancelled' }), sub.finishRun(run(b), { status: 'cancelled' })]);
    expect(res).toEqual(['ok', 'ok']);

    expect(forCard(a.cardId)).toEqual([]);
    expect(await card(a.cardId)).toEqual({ synthesized: true, frozen: true });
    const skipped = await events('synthesis_skipped', a.cardId);
    expect(skipped.map((e) => e.payload)).toEqual([{ cardId: a.cardId, reason: 'all_cancelled', runs: 2 }]);
    expect(await events('synthesis_requested', a.cardId)).toHaveLength(0);
    expect(h.titles).toEqual([[a.cardId, turn]]);
    // Later checks (the sweeper's safety net, the turn end) change nothing.
    expect(await sub.maybeSynthesize(a.cardId, { turnOver: true })).toBe(false);
    expect(await events('synthesis_skipped', a.cardId)).toHaveLength(1);
    expect(forCard(a.cardId)).toEqual([]);
  });

  it('cancelled in the turn that started it: left alone until that turn ends (it may spawn again); then finished', async () => {
    const turn = await newTurn('running', ['1790000003.000100']);
    const a = await spawn(turn, 'Topic C');
    await sub.cancelSubagent({ threadId, subagentId: a.subagentId, actor: 'U_SKP', turnId: turn }); // queued → cancelled now
    expect(await card(a.cardId)).toEqual({ synthesized: false, frozen: false });
    expect(forCard(a.cardId)).toEqual([]);

    // The turn ends without spawning again: the card is finished, no synthesis; it never went out, so no title.
    expect(await sub.maybeSynthesize(a.cardId, { turnOver: true })).toBe(false);
    expect(await card(a.cardId)).toEqual({ synthesized: true, frozen: true });
    expect(forCard(a.cardId)).toEqual([]);
    expect(await events('synthesis_skipped', a.cardId)).toHaveLength(1);
    expect(h.titles).toEqual([]);
  });

  it('cancelled, then spawned again on the same card in that turn: the new run gets its synthesis', async () => {
    const turn = await newTurn('running', ['1790000004.000100']);
    const a = await spawn(turn, 'Topic D');
    await sub.cancelSubagent({ threadId, subagentId: a.subagentId, actor: 'U_SKP', turnId: turn });
    const b = await spawn(turn, 'Topic D, narrower');
    expect(b.cardId).toBe(a.cardId);
    await sql`update runs set status = 'running' where id = ${b.runId}`;
    expect(await sub.finishRun(run(b), { status: 'complete', result: 'D is fine', output: 'D is fine' })).toBe('ok');
    expect(forCard(a.cardId)).toEqual([{ threadId, authorId: 'U_SKP', kind: 'synthesis', cardId: a.cardId }]);
    expect(await events('synthesis_skipped', a.cardId)).toHaveLength(0);
  });

  it('mixed card: exactly one synthesis turn, whose context says what changed since the round started', async () => {
    const base = Math.floor(Date.now() / 1000);
    const ts = (n: number) => `${base + n}.000100`;
    const turn = await newTurn('done', [ts(0)]);
    const a = await spawn(turn, 'Topic E');
    const b = await spawn(turn, 'Topic F');
    await sql`update runs set status = 'running' where id in ${sql([a.runId, b.runId])}`;
    // Later: a message narrowing the request, the turn answering it cancels B, the bot's reply.
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values
      (${channel}, ${ts(5)}, ${threadId}, 'U_SKP', 'placeholder one'),
      (${channel}, ${ts(7)}, ${threadId}, 'U_BOT', 'placeholder two')`;
    const later = await newTurn('done', [ts(5)]);
    await sub.cancelSubagent({ threadId, subagentId: b.subagentId, actor: 'U_SKP', turnId: later });
    await Promise.all([sub.finishRun(run(a), { status: 'complete', result: 'E is fine', output: 'E is fine' }), sub.finishRun(run(b), { status: 'cancelled' })]);

    expect(forCard(a.cardId)).toEqual([{ threadId, authorId: 'U_SKP', kind: 'synthesis', cardId: a.cardId }]);
    expect(await card(a.cardId)).toEqual({ synthesized: true, frozen: false });

    const text = since.renderSinceRound(await since.loadSinceRound(a.cardId, { userId: 'U_BOT' }));
    expect(text).toContain('Since this round started');
    expect(text).toContain(`- <@U_SKP> wrote [${ts(5)}]`);
    expect(text).toContain(`- you cancelled ${b.subagentId} "Topic F" (in your turn for [${ts(5)}])`);
    expect(text).toContain(`- you replied [${ts(7)}]`);
    // The round's own spawns and request are not news.
    expect(text).not.toContain(ts(0));
    expect(text).not.toContain('you started');

    const { renderCardResults } = await import('./front.js');
    const res = await renderCardResults(a.cardId);
    expect(res).toMatchObject({ allCancelled: false, anyCancelled: true });
  });
});
