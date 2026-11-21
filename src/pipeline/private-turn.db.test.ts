/**
 * Ephemeral mode (`@bot !p …`) against real Postgres + Redis: private turns are their own, never merged or pushed
 * into; their cards, subagents and results turns stay private; the "Send to thread" button posts once. LIVE=1.
 *   LIVE=1 pnpm vitest run src/pipeline/private-turn.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LIVE = process.env.LIVE === '1';
if (LIVE) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  process.env.SLACK_FAKE = '1';
  process.env.LOG_LEVEL ??= 'warn';
}

describe.skipIf(!LIVE)('private (`!p`) turns (DB)', () => {
  let sql: typeof import('../db/index.js').sql;
  let sched: typeof import('./scheduler.js');
  let sub: typeof import('../agent/subagents.js');
  let front: typeof import('../agent/front.js');
  let share: typeof import('../agent/private-reply.js');
  let fake: typeof import('../core/slack-fake.js');
  const channel = 'C_PRIV_TEST';
  const rootTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const threadId = `${channel}:${rootTs}`;
  const ts = (n: number) => `${rootTs.split('.')[0]}.${String(n).padStart(6, '0')}`;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    sched = await import('./scheduler.js');
    sub = await import('../agent/subagents.js');
    front = await import('../agent/front.js');
    share = await import('../agent/private-reply.js');
    fake = await import('../core/slack-fake.js');
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs}) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!LIVE) return;
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    const { redis } = await import('../core/redis.js');
    for (const q of [QUEUE.threadRun, QUEUE.subagentRun, QUEUE.cardRender]) await queue(q).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await redis.quit();
    await sql.end();
  });

  it('a private request is a turn of its own: never merged, never pushed into, once per message', async () => {
    const publicTurn = await sched.requestTurn({ threadId, authorId: 'U_A', kind: 'user', messageTs: [ts(1)], isMention: true });
    const priv = await sched.requestTurn({ threadId, authorId: 'U_A', kind: 'user', ephemeral: true, messageTs: [ts(2)] });
    expect(priv).not.toBe(publicTurn);
    // A retried intake: the same turn.
    expect(await sched.requestTurn({ threadId, authorId: 'U_A', kind: 'user', ephemeral: true, messageTs: [ts(2)] })).toBe(priv);
    // A later public message joins the public pending turn, not the private one.
    const later = await sched.scheduleMessages(threadId, 'U_A', [ts(3)], false, { allowInbox: false });
    expect(later).toEqual({ kind: 'turn', turnId: publicTurn });
    const [p] = await sql<{ messageTs: string[]; ephemeral: boolean; isMention: boolean }[]>`select message_ts, ephemeral, is_mention from turns where id = ${priv}`;
    expect(p).toEqual({ messageTs: [ts(2)], ephemeral: true, isMention: true });

    // A running private turn takes no inbox pushes.
    await sql`update turns set status = 'done' where id = ${publicTurn}`;
    await sql`update turns set status = 'running', phase = 'tools' where id = ${priv}`;
    expect(await sched.pushToRunningTurn(threadId, 'U_A', [ts(4)], true)).toBeNull();
    await sql`update turns set status = 'done', finished_at = now() where id = ${priv}`;
  });

  it("a private turn's card, subagents and results turn stay private", async () => {
    const [t] = await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, status, ephemeral) values (${threadId}, 'U_A', 'running', true) returning id::int as id`;
    const s = await sub.spawnSubagent({ threadId, turnId: t!.id, ownerId: 'U_A', title: 'Private research', instructions: 'Find X' });
    const [card] = await sql<{ ephemeral: boolean }[]>`select ephemeral from cards where id = ${s.cardId}`;
    expect(card!.ephemeral).toBe(true);
    const [sa] = await sql<{ privateTo: string | null }[]>`select private_to from subagents where id = ${s.subagentId}`;
    expect(sa!.privateTo).toBe('U_A');

    // Hidden from public turns and from other people's private turns.
    expect(await front.renderSnapshot(threadId)).not.toContain(s.subagentId);
    expect(await front.renderSnapshot(threadId, 'U_B')).not.toContain(s.subagentId);
    expect(await front.renderSnapshot(threadId, 'U_A')).toContain(s.subagentId);
    expect(await sub.subagentVisibleTo(threadId, s.subagentId, null)).toBe(false);
    expect(await sub.subagentVisibleTo(threadId, s.subagentId, 'U_A')).toBe(true);
    expect(await sub.isPublicSubagent(threadId, s.subagentId)).toBe(false);

    // A public results turn of another card doesn't see the private spawn in <since_round_start>.
    const [pub] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status, started_at) values (${threadId}, 'U_B', 'done', now() - interval '1 minute') returning id::int as id`;
    const [pubCard] = await sql<{ id: number }[]>`insert into cards (thread_id, turn_id, channel_id) values (${threadId}, ${pub!.id}, ${channel}) returning id::int as id`;
    await sql`insert into thread_events (thread_id, type, actor, payload) values (${threadId}, 'spawn', 'U_A', ${sql.json({ subagentId: s.subagentId, turnId: t!.id, cardId: s.cardId })})`;
    const { loadSinceRound } = await import('../agent/round-since.js');
    expect(JSON.stringify(await loadSinceRound(pubCard!.id))).not.toContain(s.subagentId);
    expect(JSON.stringify(await loadSinceRound(s.cardId))).not.toContain('Private research'); // its own spawn is not news

    // Its card never posts.
    const { postCard } = await import('../agent/cards.js');
    const before = (await fake.fakeCalls()).length;
    await postCard(s.cardId, null);
    expect((await fake.fakeCalls()).slice(before).filter((c) => c.method === 'chat.postMessage')).toEqual([]);

    // The results turn inherits it.
    const synth = await sched.requestTurn({ threadId, authorId: 'U_A', kind: 'synthesis', cardId: s.cardId });
    const [st] = await sql<{ ephemeral: boolean }[]>`select ephemeral from turns where id = ${synth}`;
    expect(st!.ephemeral).toBe(true);
    await sql`update turns set status = 'done' where id = ${synth}`;
    await sql`update turns set status = 'done', finished_at = now() where id = ${t!.id}`;
  });

  it("a private turn's tool calls never show in a public turn's <previous_turn_tools>", async () => {
    const [t] = await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, status, ephemeral, finished_at) values (${threadId}, 'U_A', 'done', true, now()) returning id::int as id`;
    await sql`insert into thread_events (thread_id, type, actor, payload) values (${threadId}, 'turn_tools', 'bot', ${sql.json({ turnId: t!.id, calls: [{ tool: 'web_search', args: 'secret plans' }] })})`;
    const [next] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status) values (${threadId}, 'U_B', 'running') returning id::int as id`;
    expect(await front.renderPreviousTurnTools(threadId, next!.id)).not.toContain('secret plans');
    expect(await front.renderPreviousTurnTools(threadId, next!.id, new Date(), 'U_A')).toContain('secret plans');
    await sql`update turns set status = 'done' where id = ${next!.id}`;
  });

  it('"Send to thread" posts the answer once, in the thread, for its author only', async () => {
    const id = await share.savePrivateReply({ threadId, userId: 'U_A', turnId: 1, text: 'the private answer', extras: null, files: [] });
    const ctx = (userId: string) => ({ userId, channelId: channel, actionId: share.PRIVATE_SHARE_ACTION, value: String(id), responseUrl: 'https://hooks.example/r', body: {} });
    const before = (await fake.fakeCalls()).length;
    await share.handlePrivateShare(ctx('U_B')); // not theirs
    // A press while an earlier one is still sending keeps the ephemeral (no delete_original).
    await sql`update ephemeral_replies set shared_ts = 'pending', share_claimed_at = now() where id = ${id}`;
    const mid = (await fake.fakeCalls()).length;
    await share.handlePrivateShare(ctx('U_A'));
    const pendingCalls = (await fake.fakeCalls()).slice(mid);
    expect(pendingCalls.filter((c) => c.method === 'chat.postMessage' || (c.method === 'response_url' && c.args.delete_original))).toEqual([]);
    expect(pendingCalls.some((c) => c.method === 'chat.postEphemeral' && /Already sending/.test(c.args.text))).toBe(true);
    // A claim left by a crash is retaken after a minute.
    await sql`update ephemeral_replies set share_claimed_at = now() - interval '2 minutes' where id = ${id}`;
    await share.handlePrivateShare(ctx('U_A'));
    await share.handlePrivateShare(ctx('U_A')); // double click
    const posts = (await fake.fakeCalls()).slice(before).filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args).toMatchObject({ channel, thread_ts: rootTs });
    expect(JSON.stringify(posts[0]!.args)).toContain('the private answer');
    const [row] = await sql<{ sharedTs: string | null }[]>`select shared_ts from ephemeral_replies where id = ${id}`;
    expect(row!.sharedTs).toBeTruthy();
    expect(row!.sharedTs).not.toBe('pending');
  });

  it('a retaken claim whose post is still held by an earlier press is not marked shared', async () => {
    const id = await share.savePrivateReply({ threadId, userId: 'U_A', turnId: 1, text: 'another answer', extras: null, files: [] });
    // An earlier press crashed mid-post: its claim is stale and its idempotency key has no result.
    await sql`update ephemeral_replies set shared_ts = 'pending', share_claimed_at = now() - interval '2 minutes' where id = ${id}`;
    await sql`insert into idempotency_keys (key) values (${`chat.postMessage:private-share:${id}`})`;
    const before = (await fake.fakeCalls()).length;
    await share.handlePrivateShare({ userId: 'U_A', channelId: channel, actionId: share.PRIVATE_SHARE_ACTION, value: String(id), responseUrl: 'https://hooks.example/r', body: {} });
    const calls = (await fake.fakeCalls()).slice(before);
    expect(calls.some((c) => c.method === 'response_url' && c.args.delete_original)).toBe(false);
    expect(calls.some((c) => c.method === 'chat.postEphemeral' && /Still sending/.test(c.args.text))).toBe(true);
    const [row] = await sql<{ sharedTs: string | null }[]>`select shared_ts from ephemeral_replies where id = ${id}`;
    expect(row!.sharedTs).toBeNull();
  });
});
