/**
 * Subagent/run/card lifecycle against real Postgres + Redis (no model calls). Needs local infra: LIVE=1.
 *   LIVE=1 pnpm vitest run src/agent/subagents.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const LIVE = process.env.LIVE === '1';
if (LIVE) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  process.env.SLACK_FAKE = '1';
  process.env.LOG_LEVEL ??= 'warn';
}

const requested: any[] = [];
vi.mock('../pipeline/scheduler.js', () => ({
  requestTurn: async (opts: any) => {
    requested.push(opts);
    return 1;
  },
}));

describe.skipIf(!LIVE)('subagent lifecycle (DB)', () => {
  let sql: typeof import('../db/index.js').sql;
  let sub: typeof import('./subagents.js');
  let maint: typeof import('./maintenance.js');
  const channel = 'C_SUB_TEST';
  const rootTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const threadId = `${channel}:${rootTs}`;

  async function newTurn(author = 'U_A') {
    const [t] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status) values (${threadId}, ${author}, 'running') returning id`;
    return Number(t!.id);
  }

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    sub = await import('./subagents.js');
    maint = await import('./maintenance.js');
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs}) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!LIVE) return;
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    const { redis } = await import('../core/redis.js');
    await queue(QUEUE.subagentRun).obliterate({ force: true }).catch(() => {});
    await queue(QUEUE.cardRender).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await redis.quit();
    await sql.end();
  });

  it('spawn → steer → finish (inbox guard) → single synthesis → resume → cancel', async () => {
    const turn1 = await newTurn();
    const s = await sub.spawnSubagent({ threadId, turnId: turn1, ownerId: 'U_A', title: 'Research X', instructions: 'Find X' });
    const [run] = await sql<any[]>`select * from runs where id = ${s.runId}`;
    expect(run.status).toBe('queued');
    expect(Number(run.cardId)).toBe(s.cardId);
    const [card] = await sql<any[]>`select * from cards where id = ${s.cardId}`;
    expect(Number(card.turnId)).toBe(turn1);

    // Second spawn in the same turn shares the card.
    const s2 = await sub.spawnSubagent({ threadId, turnId: turn1, ownerId: 'U_A', title: 'Research Y', instructions: 'Find Y', strong: true });
    expect(s2.cardId).toBe(s.cardId);
    const [run2] = await sql<any[]>`select model from runs where id = ${s2.runId}`;
    expect(run2.model).toContain('sol');

    // Steer while running.
    await sql`update runs set status = 'running' where id = ${s.runId}`;
    const turn2 = await newTurn();
    const m = await sub.messageSubagent({ threadId, turnId: turn2, speakerId: 'U_A', subagentId: s.subagentId, text: 'Also check the #ship channel please' });
    expect(m.mode).toBe('steered');
    const [steered] = await sql<any[]>`select steer_notes from runs where id = ${s.runId}`;
    expect(steered.steerNotes).toEqual(['Also check the #ship channel please']);
    const inbox = await sql`select * from subagent_inbox where subagent_id = ${s.subagentId} and consumed_at is null`;
    expect(inbox).toHaveLength(1);
    // No card for the steering turn.
    expect(await sql`select * from cards where turn_id = ${turn2}`).toHaveLength(0);

    // Finishing with an unseen steer is refused.
    const r1 = { id: s.runId, subagentId: s.subagentId, threadId, cardId: s.cardId };
    expect(await sub.finishRun(r1, { status: 'complete', result: 'X is 42', output: 'X is 42' })).toBe('inbox');
    await sql`update subagent_inbox set consumed_at = now() where subagent_id = ${s.subagentId}`;
    expect(await sub.finishRun(r1, { status: 'complete', result: 'X is 42', output: 'X is 42' }, { history: [{ role: 'user', content: 'Find X' }] })).toBe('ok');
    expect(await sub.finishRun(r1, { status: 'error', error: 'late' })).toBe('gone');
    const [sa] = await sql<any[]>`select * from subagents where id = ${s.subagentId}`;
    expect(sa.status).toBe('idle');
    expect(sa.summary).toBe('X is 42');
    expect(sa.history).toHaveLength(1);
    // Other run on the card still active → no synthesis yet.
    expect(requested.filter((r) => r.cardId === s.cardId)).toHaveLength(0);

    // Cancel the queued second run → card done → exactly one synthesis.
    const msg = await sub.cancelSubagent({ threadId, subagentId: s2.subagentId, actor: 'U_A' });
    expect(msg).toContain('cancelled');
    const [c2] = await sql<any[]>`select r.status, s.status as sa_status from runs r join subagents s on s.id = r.subagent_id where r.id = ${s2.runId}`;
    expect(c2.status).toBe('cancelled');
    expect(c2.saStatus).toBe('cancelled');
    expect(requested.filter((r) => r.cardId === s.cardId)).toEqual([{ threadId, authorId: 'U_A', kind: 'synthesis', cardId: s.cardId }]);
    expect(await sub.maybeSynthesize(s.cardId)).toBe(false);

    // Cancelled subagent can't be messaged.
    await expect(sub.messageSubagent({ threadId, turnId: turn2, speakerId: 'U_A', subagentId: s2.subagentId, text: 'hi' })).rejects.toThrow(/cancelled/);

    // Idle → resume on this turn's card, marked as resume.
    const turn3 = await newTurn();
    const res = await sub.messageSubagent({ threadId, turnId: turn3, speakerId: 'U_A', subagentId: s.subagentId, text: 'Now compare X with Z' });
    expect(res.mode).toBe('resumed');
    const [resumed] = await sql<any[]>`select * from runs where id = ${res.runId}`;
    expect(resumed.isResume).toBe(true);
    expect(Number(resumed.cardId)).not.toBe(s.cardId);
    const [card3] = await sql<any[]>`select * from cards where id = ${resumed.cardId}`;
    expect(Number(card3.turnId)).toBe(turn3);

    // Stop all on that card: queued run cancelled immediately.
    await sub.cancelCardRuns(Number(resumed.cardId), 'U_B');
    const [stopped] = await sql<any[]>`select status from runs where id = ${res.runId}`;
    expect(stopped.status).toBe('cancelled');
    expect(requested.filter((r) => r.cardId === Number(resumed.cardId))).toHaveLength(1);
  });

  it('a run that completes after cancellation was requested is recorded as cancelled (result kept), synthesis silent', async () => {
    const turn = await newTurn('U_F');
    const s = await sub.spawnSubagent({ threadId, turnId: turn, ownerId: 'U_F', title: 'Pico research', instructions: 'Compare Pico models' });
    await sql`update runs set status = 'running' where id = ${s.runId}`;
    const msg = await sub.cancelSubagent({ threadId, subagentId: s.subagentId, actor: 'U_F' });
    expect(msg).toMatch(/next step/);
    expect(requested.filter((r) => r.cardId === s.cardId)).toHaveLength(0);
    // The loop finishes its last step without having seen the cancel.
    const r = { id: s.runId, subagentId: s.subagentId, threadId, cardId: s.cardId };
    expect(await sub.finishRun(r, { status: 'complete', result: 'Pico 2 is newest', output: 'Pico 2' })).toBe('ok');
    const [run] = await sql<any[]>`select status, result from runs where id = ${s.runId}`;
    expect(run).toEqual({ status: 'cancelled', result: 'Pico 2 is newest' });
    const [sa] = await sql<any[]>`select status from subagents where id = ${s.subagentId}`;
    expect(sa.status).toBe('cancelled');
    const [ev] = await sql<any[]>`select payload from thread_events where thread_id = ${threadId} and type = 'run_finished' order by id desc limit 1`;
    expect(ev.payload).toMatchObject({ status: 'cancelled', finishedAfterCancel: true });
    expect(requested.filter((x) => x.cardId === s.cardId)).toHaveLength(1);
    const { renderCardResults } = await import('./front.js');
    const res = await renderCardResults(s.cardId);
    expect(res.allCancelled).toBe(true);
    expect(res.text).toContain('Cancelled before finishing.');
    expect(res.text).not.toContain('Pico 2 is newest');
  });

  it('sweeper fails stale runs and expiry retires idle subagents', async () => {
    const turn = await newTurn('U_C');
    const s = await sub.spawnSubagent({ threadId, turnId: turn, ownerId: 'U_C', title: 'Stale', instructions: 'x' });
    await sql`update runs set status = 'running', heartbeat_at = now() - interval '10 minutes' where id = ${s.runId}`;
    await maint.sweepStaleRuns();
    const [r] = await sql<any[]>`select status, error from runs where id = ${s.runId}`;
    expect(r).toEqual({ status: 'error', error: 'Worker stopped' });
    const [sa] = await sql<any[]>`select status from subagents where id = ${s.subagentId}`;
    expect(sa.status).toBe('idle');
    expect(requested.filter((x) => x.cardId === s.cardId)).toHaveLength(1);

    await sql`update subagents set last_active_at = now() - interval '25 hours' where id = ${s.subagentId}`;
    await maint.expireIdleSubagents();
    const [sa2] = await sql<any[]>`select status from subagents where id = ${s.subagentId}`;
    expect(sa2.status).toBe('expired');
    await expect(sub.messageSubagent({ threadId, turnId: turn, speakerId: 'U_C', subagentId: s.subagentId, text: 'hi' })).rejects.toThrow(/seed_from/);

    // Seeded respawn carries the old summary.
    await sql`update subagents set summary = 'old findings' where id = ${s.subagentId}`;
    const s2 = await sub.spawnSubagent({ threadId, turnId: await newTurn('U_C'), ownerId: 'U_C', title: 'Again', instructions: 'continue', seedFrom: s.subagentId });
    const [sa3] = await sql<any[]>`select seeded_from from subagents where id = ${s2.subagentId}`;
    expect(sa3.seededFrom).toBe(s.subagentId);
    const [run3] = await sql<any[]>`select instructions from runs where id = ${s2.runId}`;
    expect(run3.instructions).toContain('old findings');
    await sub.cancelSubagent({ threadId, subagentId: s2.subagentId, actor: 'U_C' });
  });

  it('enforces the per-thread concurrency limit', async () => {
    const { limits } = await import('../config.js');
    const turn = await newTurn('U_D');
    const ids: string[] = [];
    const active = (await sql<{ n: number }[]>`select count(*)::int as n from runs where thread_id = ${threadId} and status in ('queued','running')`)[0]!.n;
    for (let i = active; i < limits.threadConcurrentSubagents; i++) {
      ids.push((await sub.spawnSubagent({ threadId, turnId: turn, ownerId: `U_D${i}`, title: `T${i}`, instructions: 'x' })).subagentId);
    }
    await expect(sub.spawnSubagent({ threadId, turnId: turn, ownerId: 'U_E', title: 'one too many', instructions: 'x' })).rejects.toThrow(/thread/);
    for (const id of ids) await sub.cancelSubagent({ threadId, subagentId: id, actor: 'U_D' });
  });
});
