/**
 * Background titles against the test Postgres/Redis and the fake Slack, with the title model replaced (no network):
 * a DM turn's job titles the session (agents.sessions.rename) with no tool call in the turn, waits through greetings,
 * re-checks only every few turns (KEEP keeps), never touches a user title; a finished card gets its title.
 *   INTEGRATION=1 pnpm vitest run src/agent/titles.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.LOG_LEVEL = 'silent';
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('background titles', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fake: typeof import('../core/slack-fake.js');
  let T: typeof import('./titles.js');
  let Q: typeof import('../core/queues.js');
  const created: string[] = [];
  const asked: { system: string; prompt: string }[] = [];
  let answer = 'Pico W pinout question';
  let tsN = 100;

  async function thread(isDm = true) {
    const channelId = `${isDm ? 'D' : 'C'}TT${rand()}`;
    const threadTs = `1700000000.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const id = `${channelId}:${threadTs}`;
    await sql`insert into threads (id, channel_id, thread_ts, is_dm, engaged) values (${id}, ${channelId}, ${threadTs}, ${isDm}, true)`;
    created.push(id);
    return { id, channelId, threadTs };
  }
  /** A user message + its turn (done), and the bot's reply. Returns the turn id. */
  async function exchange(t: { id: string; channelId: string }, userText: string, botText = 'Here you go.') {
    const ts = `1700000001.${String(tsN++).padStart(6, '0')}`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${t.channelId}, ${ts}, ${t.id}, 'UHUMAN', ${userText})`;
    const [turn] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, kind, message_ts, status) values (${t.id}, 'UHUMAN', 'user', ${[ts]}, 'done') returning id`;
    const bts = `1700000001.${String(tsN++).padStart(6, '0')}`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, text) values (${t.channelId}, ${bts}, ${t.id}, 'UBOT', 'BBOT', ${botText})`;
    return Number(turn!.id);
  }
  const renames = async (channelId: string) => (await fake.fakeCalls()).filter((c) => c.method === 'agents.sessions.rename' && c.args.channel_id === channelId).map((c) => c.args.title);
  const session = async (threadId: string) => (await sql<any[]>`select * from agent_sessions where thread_id = ${threadId}`)[0];
  /** What a DM turn does at its end (enqueueSessionTitle), then what the worker does with that job. */
  async function runSessionJob(threadId: string, turnId: number) {
    await T.enqueueSessionTitle(threadId, turnId);
    const job = (await Q.queue(Q.QUEUE.titles).getJobs(['waiting', 'delayed', 'prioritized'])).find((j) => j.data.threadId === threadId && j.data.turnId === turnId);
    expect(job, 'enqueued').toBeTruthy();
    await T.processTitleJob(job!.data);
    await job!.remove();
  }

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    fake = await import('../core/slack-fake.js');
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    T = await import('./titles.js');
    Q = await import('../core/queues.js');
    T.titleModel.generate = async (o) => {
      asked.push(o);
      return { text: answer, inputTokens: 50, outputTokens: 5 };
    };
  });

  afterAll(async () => {
    if (!sql) return;
    if (created.length) await sql`delete from threads where id = any(${created})`;
    await Q.queue(Q.QUEUE.titles).obliterate({ force: true }).catch(() => {});
    await Q.closeQueues();
    await sql.end();
    redis.disconnect();
  });

  beforeEach(() => {
    asked.length = 0;
    answer = 'Pico W pinout question';
  });

  it('a DM: greetings wait; the first request gets a title via agents.sessions.rename; usage recorded', async () => {
    const t = await thread();
    const greet = await exchange(t, 'hi there!', 'Hi! What can I do for you?');
    await runSessionJob(t.id, greet);
    expect(asked).toHaveLength(0); // no model call for a greeting
    expect(await renames(t.channelId)).toEqual([]);

    const turn = await exchange(t, 'what pins does the Pico W use for I2C?', 'GP4 (SDA) and GP5 (SCL) by default.');
    await runSessionJob(t.id, turn);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toContain('what pins does the Pico W use for I2C?');
    expect(asked[0]!.prompt).not.toContain('hi there');
    expect(asked[0]!.prompt).toContain('GP4 (SDA)');
    expect(await renames(t.channelId)).toEqual(['Pico W pinout question']);
    expect(await session(t.id)).toMatchObject({ title: 'Pico W pinout question', titleBy: 'bot', titleTurnId: String(turn) });
    const [usage] = await sql<any[]>`select * from usage where thread_id = ${t.id} and kind = 'model'`;
    expect(usage).toMatchObject({ userId: 'UHUMAN', inputTokens: 50, outputTokens: 5 });
  });

  it('re-checks only every few user turns; KEEP keeps the title, a new topic retitles', async () => {
    const t = await thread();
    const first = await exchange(t, 'what pins does the Pico W use for I2C?');
    await runSessionJob(t.id, first);
    asked.length = 0;
    const turns: number[] = [];
    for (let i = 0; i < T.SESSION_RETITLE_EVERY; i++) turns.push(await exchange(t, `follow-up ${i} about the pins`));
    answer = 'KEEP';
    for (const id of turns) await runSessionJob(t.id, id);
    expect(asked).toHaveLength(1); // only on the SESSION_RETITLE_EVERY-th turn
    expect(asked[0]!.system).toContain('currently titled "Pico W pinout question"');
    expect(await renames(t.channelId)).toEqual(['Pico W pinout question']);

    for (let i = 0; i < T.SESSION_RETITLE_EVERY; i++) turns.push(await exchange(t, `now help me with my resume, part ${i}`));
    answer = 'Resume review';
    for (const id of turns.slice(T.SESSION_RETITLE_EVERY)) await runSessionJob(t.id, id);
    expect(await renames(t.channelId)).toEqual(['Pico W pinout question', 'Resume review']);
  });

  it("never overrides a user-chosen title (no model call either), and channel threads aren't titled", async () => {
    const t = await thread();
    await sql`insert into agent_sessions (thread_id, title, title_by, user_renamed_at) values (${t.id}, 'My robot project', 'user', now())`;
    for (let i = 0; i < 2 * T.SESSION_RETITLE_EVERY; i++) await runSessionJob(t.id, await exchange(t, `question ${i} about servos`));
    expect(asked).toHaveLength(0);
    expect(await renames(t.channelId)).toEqual([]);
    expect(await session(t.id)).toMatchObject({ title: 'My robot project', titleBy: 'user' });

    const c = await thread(false);
    await runSessionJob(c.id, await exchange(c, 'what pins does the Pico W use?'));
    expect(asked).toHaveLength(0);
    expect(await session(c.id)).toBeUndefined();
  });

  it('a finished card gets its past-tense title and re-renders; not while a run is still active', async () => {
    const t = await thread(false);
    const turn = await exchange(t, 'compare fly.io, render and railway for a small node app');
    const [card] = await sql<{ id: number }[]>`insert into cards (thread_id, turn_id, channel_id, frozen) values (${t.id}, ${turn}, ${t.channelId}, true) returning id`;
    const cardId = Number(card!.id);
    const sas: string[] = [];
    for (const [title, status] of [
      ['Fly.io pricing', 'complete'],
      ['Render pricing', 'complete'],
      ['Railway pricing', 'running'],
    ]) {
      const id = `sa_${rand().toLowerCase()}`;
      sas.push(id);
      await sql`insert into subagents (id, thread_id, owner_id, title, status) values (${id}, ${t.id}, 'UHUMAN', ${title!}, 'idle')`;
      await sql`insert into runs (subagent_id, thread_id, card_id, instructions, status, output) values (${id}, ${t.id}, ${cardId}, ${`price ${title}`}, ${status!}, ${`${title} costs a few dollars`})`;
    }
    answer = 'Compared 3 hosting options';
    expect(await T.processCardTitle(cardId)).toBe('skip:active');
    expect(asked).toHaveLength(0);
    await sql`update runs set status = 'complete' where card_id = ${cardId}`;
    await T.enqueueCardTitle(cardId, 99);
    const job = (await Q.queue(Q.QUEUE.titles).getJobs(['waiting'])).find((j) => j.data.cardId === cardId)!;
    await T.processTitleJob(job.data);
    await job.remove();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toContain('compare fly.io, render and railway');
    expect(asked[0]!.prompt).toContain('- Railway pricing [complete]: Railway pricing costs a few dollars');
    const [row] = await sql<any[]>`select title from cards where id = ${cardId}`;
    expect(row.title).toBe('Compared 3 hosting options');
    // KEEP / nothing usable leaves the default ("Ran N subagents").
    await sql`update cards set title = null where id = ${cardId}`;
    answer = 'KEEP';
    expect(await T.processCardTitle(cardId)).toBe('keep');
    expect((await sql<any[]>`select title from cards where id = ${cardId}`)[0].title).toBeNull();
  });
});
