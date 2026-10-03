/**
 * Integration tests (LIVE=1): real Postgres/Redis (from .env), SLACK_FAKE Slack, real OpenRouter.
 * Other modules' contracts (thread rendering, requestTurn) are replaced with test doubles.
 *   LIVE=1 pnpm vitest run src/agent/agent.live.test.ts
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
const threadText = new Map<string, { history: string; newMessages: string }>();

vi.mock('../context/thread.js', () => ({
  renderThreadContext: async (threadId: string) => ({
    history: threadText.get(threadId)?.history ?? '',
    channelContext: '',
    newMessages: threadText.get(threadId)?.newMessages ?? '',
  }),
  renderMessages: async (_threadId: string, ts: string[]) => ts.map((t) => `<@U_TEST> Tester: (message ${t})`).join('\n'),
}));

vi.mock('../pipeline/scheduler.js', () => ({
  requestTurn: async (opts: any) => {
    const { sql } = await import('../db/index.js');
    const [row] = await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, kind, card_id, is_mention, message_ts)
      values (${opts.threadId}, ${opts.authorId}, ${opts.kind}, ${opts.cardId ?? null}, ${opts.isMention ?? false}, ${opts.messageTs ?? []}) returning id`;
    requested.push({ ...opts, turnId: Number(row!.id) });
    return Number(row!.id);
  },
}));

describe.skipIf(!LIVE)('agent integration (LIVE)', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;

  const user = `U_TEST${Date.now().toString(36).toUpperCase()}`;
  const channel = 'C_AGENT_TEST';
  const rootTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const threadId = `${channel}:${rootTs}`;

  const io = (isMention = true) => ({
    drainInbox: async () => [],
    setPhase: async () => {},
    isMention,
  });

  async function insertTurn(kind: 'user' | 'synthesis', messageTs: string[], cardId: number | null = null) {
    const [row] = await sql<any[]>`
      insert into turns (thread_id, author_id, kind, is_mention, message_ts, card_id, status)
      values (${threadId}, ${user}, ${kind}, true, ${messageTs}, ${cardId}, 'running') returning *`;
    return { ...row, id: Number(row.id), cardId: row.cardId ? Number(row.cardId) : null };
  }

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    await import('./register.js');
    await import('../tools/index.js');
    await import('../features/register.js');
    await redis.del('slack:fake:calls');
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${threadId}, ${channel}, ${rootTs}, true) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!LIVE) return;
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    await queue(QUEUE.subagentRun).obliterate({ force: true }).catch(() => {});
    await queue(QUEUE.cardRender).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await redis.quit();
    await sql.end();
  });

  it('front turn spawns a subagent, the run completes, synthesis streams below the frozen card', async () => {
    const { runFrontTurn } = await import('./front.js');
    const { processSubagentRun } = await import('./child.js');
    const { processCardRender } = await import('./cards.js');

    threadText.set(threadId, {
      history: `<@${user}> Tester: hey bot`,
      newMessages: `<@${user}> Tester: @Smasnug please start a background subagent (spawn_subagent) to write a short comparison of the programming languages Rust and Go (3 bullet points each). Don't answer yourself — delegate it.`,
    });
    const turn1 = await insertTurn('user', [rootTs]);
    await runFrontTurn(turn1, io());

    const subagents = await sql<any[]>`select * from subagents where thread_id = ${threadId}`;
    expect(subagents.length).toBeGreaterThanOrEqual(1);
    expect(subagents[0].ownerId).toBe(user);
    const runs = await sql<any[]>`select * from runs where thread_id = ${threadId} order by id`;
    expect(runs.length).toBe(subagents.length);
    const cardId = Number(runs[0].cardId);
    const [card] = await sql<any[]>`select * from cards where id = ${cardId}`;
    expect(card.turnId).toBe(String(turn1.id));
    expect(card.messageTs).toBeTruthy();

    let calls = await fakeCalls();
    const hasPlan = (c: any) => c.args.blocks?.some((b: any) => b.type === 'plan');
    const replied = (await sql<any[]>`select 1 from thread_events where thread_id = ${threadId} and type = 'reply'`).length > 0;
    const cardMsg = calls.find((c) => (c.method === 'chat.postMessage' || c.method === 'chat.update') && hasPlan(c) && c.args.channel === channel);
    expect(cardMsg).toBeTruthy();
    expect(cardMsg!.args.text).toBeTruthy();
    if (replied) {
      // The card lives in the turn's reply: chat.update of that message, no separate card post.
      expect(cardMsg!.method).toBe('chat.update');
      expect(cardMsg!.args.ts).toBe(card.messageTs);
      expect(cardMsg!.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'plan', 'actions']);
      expect(calls.some((c) => c.method === 'chat.postMessage' && hasPlan(c) && c.args.channel === channel)).toBe(false);
    } else {
      expect(cardMsg!.method).toBe('chat.postMessage');
      expect(cardMsg!.args.thread_ts).toBe(rootTs);
    }
    expect(cardMsg!.args.blocks.find((b: any) => b.type === 'actions')?.elements?.[0]?.action_id).toBe('card:stop_all');
    const events1 = await sql<any[]>`select type from thread_events where thread_id = ${threadId}`;
    expect(events1.map((e) => e.type)).toContain('spawn');

    // Run every subagent (the worker would do this via the subagent-run queue).
    for (const r of runs) await processSubagentRun(Number(r.id));
    const done = await sql<any[]>`select * from runs where thread_id = ${threadId} order by id`;
    for (const r of done) {
      expect(r.status).toBe('complete');
      expect(r.output).toBeTruthy();
      expect(r.result).toBeTruthy();
    }
    const [sa] = await sql<any[]>`select * from subagents where id = ${subagents[0].id}`;
    expect(sa.status).toBe('idle');
    expect(sa.summary).toBeTruthy();
    expect(Array.isArray(sa.history) && sa.history.length).toBeGreaterThanOrEqual(2);

    // Exactly one synthesis request for the card.
    const synth = requested.filter((r) => r.cardId === cardId);
    expect(synth).toHaveLength(1);
    expect(synth[0]).toMatchObject({ threadId, authorId: user, kind: 'synthesis' });

    await processCardRender(cardId);
    calls = await fakeCalls();
    const update = calls.filter((c) => c.method === 'chat.update' && c.args.ts === card.messageTs).at(-1);
    expect(update?.args.blocks.find((b: any) => b.type === 'plan').title).toMatch(/^Ran \d subagents?$/);

    // Synthesis turn.
    const before = calls.length;
    const [synthTurn] = await sql<any[]>`select * from turns where id = ${synth[0].turnId}`;
    await runFrontTurn({ ...synthTurn, id: Number(synthTurn.id), cardId: Number(synthTurn.cardId), messageTs: [] }, io(false));

    calls = (await fakeCalls()).slice(before);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('chat.startStream');
    expect(methods).toContain('chat.stopStream');
    const start = calls.find((c) => c.method === 'chat.startStream')!;
    expect(start.args.thread_ts).toBe(rootTs);
    expect(start.args.recipient_user_id).toBe(user);
    const streamed = calls.filter((c) => c.method === 'chat.startStream' || c.method === 'chat.appendStream').map((c) => c.args.markdown_text).join('');
    expect(streamed.length).toBeGreaterThan(20);

    const frozen = calls.filter((c) => c.method === 'chat.update' && c.args.ts === card.messageTs).at(-1);
    expect(frozen).toBeTruthy();
    expect(frozen!.args.blocks.some((b: any) => b.type === 'actions')).toBe(false); // no Stop all button
    const [card2] = await sql<any[]>`select * from cards where id = ${cardId}`;
    expect(card2.frozen).toBe(true);
    expect(card2.synthesized).toBe(true);
    const reported = await sql<any[]>`select reported from runs where card_id = ${cardId}`;
    expect(reported.every((r) => r.reported)).toBe(true);
    const events = await sql<any[]>`select type, payload from thread_events where thread_id = ${threadId} order by id`;
    expect(events.filter((e) => e.type === 'reply').length).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log('card title:', frozen!.args.blocks.find((b: any) => b.type === 'plan').title, '| in reply:', replied, '| synthesis:', streamed.slice(0, 200));
  }, 180_000);

  async function freshThread(tag: string) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const id = `C_${tag}:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${id}, ${`C_${tag}`}, ${ts}, true)`;
    return { id, ts };
  }

  async function runningSubagent(tid: string, owner: string, title: string) {
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, status) values (${tid}, ${owner}, 'done') returning id`;
    const { ensureTurnCard } = await import('./cards.js');
    const cardId = await ensureTurnCard({ threadId: tid, turnId: Number(t.id) });
    const saId = `sa_t${Math.random().toString(36).slice(2, 7)}`;
    await sql`insert into subagents (id, thread_id, owner_id, title, status) values (${saId}, ${tid}, ${owner}, ${title}, 'running')`;
    const [r] = await sql<any[]>`insert into runs (subagent_id, thread_id, card_id, turn_id, instructions, status, details, heartbeat_at, started_at)
      values (${saId}, ${tid}, ${cardId}, ${t.id}, 'Research the best laptops under $800 for programming', 'running', 'Searching the web for “laptops under 800”', now(), now()) returning id`;
    return { saId, runId: Number(r.id), cardId };
  }

  it('steers a running subagent and posts (not streams) while runs are active', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('STEER');
    const { saId, runId } = await runningSubagent(th.id, user, 'Laptops under $800');
    const msgTs = `${Number(th.ts) + 5}.000100`;
    threadText.set(th.id, {
      history: `<@${user}> Tester: @Smasnug find me the best laptops under $800 for programming\n[bot] Smasnug: On it.`,
      newMessages: `<@${user}> Tester: @Smasnug oh and they need to have at least 16GB of RAM`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, true, ${[msgTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io());
    const inbox = await sql<any[]>`select text from subagent_inbox where subagent_id = ${saId}`;
    expect(inbox.length).toBe(1);
    expect(inbox[0].text).toMatch(/16/);
    const [run] = await sql<any[]>`select steer_notes from runs where id = ${runId}`;
    expect(run.steerNotes.length).toBe(1);
    expect(await sql`select * from cards where turn_id = ${t.id}`).toHaveLength(0);
    const calls = (await fakeCalls()).slice(before);
    expect(calls.map((c) => c.method)).not.toContain('chat.startStream');
    // eslint-disable-next-line no-console
    console.log('steer note:', run.steerNotes, '| calls:', calls.map((c) => `${c.method} ${c.args.text ?? ''}`.slice(0, 120)));
  }, 90_000);

  it('"stop" cancels the speaker\'s subagent and stays quiet', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('STOP');
    const { saId, runId } = await runningSubagent(th.id, user, 'Laptops under $800');
    threadText.set(th.id, {
      history: `<@${user}> Tester: @Smasnug find me the best laptops under $800 for programming`,
      newMessages: `<@${user}> Tester: @Smasnug stop, never mind`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, true, ${[`${Number(th.ts) + 9}.000200`]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io());
    const [run] = await sql<any[]>`select cancel_requested from runs where id = ${runId}`;
    expect(run.cancelRequested).toBe(true);
    const calls = (await fakeCalls()).slice(before);
    const posts = calls.filter((c) => ['chat.postMessage', 'chat.startStream'].includes(c.method));
    // eslint-disable-next-line no-console
    console.log('stop posts:', posts.map((c) => c.args.text ?? c.args.markdown_text));
    expect(posts.length).toBeLessThanOrEqual(1);
    void saId;
  }, 90_000);

  it('unmentioned chatter between people stays silent (no fallback)', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('QUIET');
    threadText.set(th.id, {
      history: `<@U_SAM> Sam: @Smasnug what's the deadline for the hackathon signup?\n[bot] Smasnug: It's Friday at 5pm.\n<@U_SAM> Sam: thanks!`,
      newMessages: `<@${user}> Tester: <@U_SAM> are you bringing the extension cords tomorrow?`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, false, ${[`${Number(th.ts) + 3}.000300`]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(false));
    const calls = (await fakeCalls()).slice(before);
    expect(calls.filter((c) => ['chat.postMessage', 'chat.startStream'].includes(c.method))).toHaveLength(0);
  }, 60_000);

  it('a subagent can use web search (server tool) and reports with sources', async () => {
    const { spawnSubagent } = await import('./subagents.js');
    const { processSubagentRun } = await import('./child.js');
    const th = await freshThread('WEB');
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, status) values (${th.id}, ${user}, 'running') returning id`;
    const s = await spawnSubagent({
      threadId: th.id,
      turnId: Number(t.id),
      ownerId: user,
      title: 'Node LTS version',
      instructions: 'Use one web search to find the current Node.js LTS major version. Report the version and the source URL.',
    });
    await processSubagentRun(s.runId);
    const [run] = await sql<any[]>`select status, result, output, error, tokens from runs where id = ${s.runId}`;
    // eslint-disable-next-line no-console
    console.log('web run:', run.status, run.output, run.tokens, String(run.result).slice(0, 300));
    expect(run.status).toBe('complete');
    expect(run.result).toMatch(/https?:\/\//);
  }, 120_000);

  // ---- Behaviour (the real-Slack incident replayed): decisive delegation, rare reactions. ----

  async function dmTurn(tag: string, history: string, text: string) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const tid = `D_${tag}${Math.random().toString(36).slice(2, 6).toUpperCase()}:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${tid}, ${tid.split(':')[0]!}, ${ts}, true)`;
    const msgTs = `${Number(ts) + 30}.000100`;
    threadText.set(tid, { history, newMessages: `[${msgTs}] <@${user}> Tester: ${text}` });
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${tid}, ${user}, true, ${[msgTs]}, 'running') returning *`;
    return { tid, turn: { ...t, id: Number(t.id) } };
  }

  async function outcome(tid: string, before: number) {
    const calls = (await fakeCalls()).slice(before).filter((c) => (c.args.channel ?? '') === tid.split(':')[0]);
    const events = await sql<any[]>`select type, payload from thread_events where thread_id = ${tid} order by id`;
    const replies = events.filter((e) => e.type === 'reply' && !e.payload.fallback && !e.payload.stopped);
    const cards = await sql<any[]>`select title from cards where thread_id = ${tid}`;
    return {
      replies: replies.map((e) => String(e.payload.text)),
      reactionsAdded: calls.filter((c) => c.method === 'reactions.add').length,
      reactionsLeft: calls.filter((c) => c.method === 'reactions.add').length - calls.filter((c) => c.method === 'reactions.remove').length,
      spawns: events.filter((e) => e.type === 'spawn').length,
      cancels: events.filter((e) => e.type === 'cancel').length,
      dropped: events.filter((e) => e.type === 'reply_dropped').map((e) => e.payload.reason),
      cardTitles: cards.map((c) => c.title),
    };
  }

  it('the Pico research request delegates once: one spawn, at most one ack, no reaction, no cancel', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn(
      'PICO',
      '',
      'can you research what the latest Raspberry Pi Pico model is and how it compares to the original Pico? take your time',
    );
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    console.log('pico:', JSON.stringify(o));
    expect(o.spawns).toBe(1);
    expect(o.replies.length).toBeLessThanOrEqual(1);
    expect(o.reactionsAdded).toBe(0);
    expect(o.cancels).toBe(0);
    expect(o.cardTitles.every((t) => t == null)).toBe(true); // set_card_title not offered / not used
  }, 120_000);

  it('"hi! what can you do?" gets one reply and no reaction', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn('HI', '', 'hi! what can you do?');
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    console.log('hi:', JSON.stringify(o));
    expect(o.replies).toHaveLength(1);
    expect(o.reactionsAdded).toBe(0);
    expect(o.spawns).toBe(0);
  }, 90_000);

  it('"thanks!" after an answer gets a reaction only, no reply', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn(
      'THX',
      `[1790000000.000100] <@${user}> Tester: what's the default GPIO voltage on a Raspberry Pi Pico?\n[1790000005.000100] [bot] smasnug ai (you): The Pico's GPIO runs at 3.3V — don't feed 5V into the pins directly.`,
      'thanks!',
    );
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    console.log('thanks:', JSON.stringify(o));
    expect(o.replies).toHaveLength(0);
    expect(o.reactionsAdded).toBe(1);
    expect(o.spawns).toBe(0);
  }, 90_000);
});
