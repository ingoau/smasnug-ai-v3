/**
 * DM agent sessions against the test Postgres/Redis (fake Slack): titles (one per turn, user renames win, echo
 * detection), DM-only gating, and the end-of-turn statuses (closed after leave_thread, suspended while a send
 * confirmation is pending, back to active when it resolves or the user writes again).
 * Run: INTEGRATION=1 pnpm vitest run src/pipeline/agent-session.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.LOG_LEVEL = 'silent';
});
vi.mock('../agent/front.js', () => ({ runFrontTurn: vi.fn() }));

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const job = <D>(data: D) => ({ data, id: 'test' }) as unknown as Job<D>;

describe.skipIf(!INTEGRATION)('agent sessions (DMs)', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fake: typeof import('../core/slack-fake.js');
  let s: typeof import('./agent-session.js');
  let scheduler: typeof import('./scheduler.js');
  let processThreadRun: typeof import('./thread-run.js').processThreadRun;
  let processSlackEvent: typeof import('./slack-events.js').processSlackEvent;
  let run: any;
  const created: string[] = [];

  async function thread(isDm: boolean) {
    const channelId = `${isDm ? 'D' : 'C'}T${rand()}`;
    const threadTs = `1700000000.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const id = `${channelId}:${threadTs}`;
    await sql`insert into threads (id, channel_id, thread_ts, is_dm, engaged) values (${id}, ${channelId}, ${threadTs}, ${isDm}, true)`;
    created.push(id);
    return { id, channelId, threadTs };
  }
  const calls = async (channelId: string, method?: string) =>
    (await fake.fakeCalls()).filter((c) => (c.args.channel_id ?? c.args.channel) === channelId && (!method || c.method === method));
  const statuses = async (channelId: string) => (await calls(channelId, 'agents.sessions.setStatus')).map((c) => c.args.status);
  const row = async (threadId: string) => (await sql`select * from agent_sessions where thread_id = ${threadId}`)[0];
  const titleEvent = (t: { channelId: string; threadTs: string }, title: string, user?: string) =>
    job({ kind: 'event' as const, body: { event: { type: 'agent_session_title_changed', channel: t.channelId, thread_ts: t.threadTs, title, ...(user ? { user } : {}), event_ts: '1783536983.783769' } } });

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    fake = await import('../core/slack-fake.js');
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    s = await import('./agent-session.js');
    scheduler = await import('./scheduler.js');
    ({ processThreadRun } = await import('./thread-run.js'));
    ({ processSlackEvent } = await import('./slack-events.js'));
    run = vi.mocked((await import('../agent/front.js')).runFrontTurn);
  });

  afterAll(async () => {
    if (!sql) return;
    if (created.length) await sql`delete from threads where id = any(${created})`;
    await sql.end();
    redis.disconnect();
  });

  beforeEach(async () => {
    await redis.del('slack:fake:calls');
    run.mockReset();
    run.mockResolvedValue(undefined);
  });

  describe('titles', () => {
    it('DM: renames the session once per turn; a later turn may retitle', async () => {
      const t = await thread(true);
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 1, title: 'Pico W pinout question' })).toBe('Conversation titled "Pico W pinout question".');
      expect((await calls(t.channelId, 'agents.sessions.rename')).map((c) => c.args)).toEqual([{ channel_id: t.channelId, thread_ts: t.threadTs, title: 'Pico W pinout question' }]);
      expect(await row(t.id)).toMatchObject({ title: 'Pico W pinout question', titleBy: 'bot' });
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 1, title: 'Something else' })).toMatch(/already titled this conversation this turn/);
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 2, title: 'Pico W pinout question' })).toMatch(/^Title unchanged/);
      expect(await calls(t.channelId, 'agents.sessions.rename')).toHaveLength(1);
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 3, title: 'Pico W power budget' })).toMatch(/^Conversation titled/);
      expect(await calls(t.channelId, 'agents.sessions.rename')).toHaveLength(2);
    });

    it('channel threads never get a title', async () => {
      const t = await thread(false);
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 1, title: 'Hello' })).toMatch(/only for DM conversations/);
      expect(await calls(t.channelId)).toEqual([]);
      expect(await s.loadSessionInfo(t.id)).toEqual({ isDm: false, title: null, titleBy: null });
    });

    it('a user rename is stored and never overwritten', async () => {
      const t = await thread(true);
      await s.setSessionTitle({ threadId: t.id, turnId: 1, title: 'Pico question' });
      await processSlackEvent(titleEvent(t, 'My robot project', 'U1'));
      expect(await row(t.id)).toMatchObject({ title: 'My robot project', titleBy: 'user', userRenamedAt: expect.any(Date) });
      expect(await s.loadSessionInfo(t.id)).toEqual({ isDm: true, title: 'My robot project', titleBy: 'user' });
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 2, title: 'Robot arm torque' })).toBe('Not renamed: the user named this conversation "My robot project" themselves. Keep their title.');
      expect(await calls(t.channelId, 'agents.sessions.rename')).toHaveLength(1);
      const ev = await sql`select type, actor from thread_events where thread_id = ${t.id} and type = 'session_renamed'`;
      expect(ev).toEqual([{ type: 'session_renamed', actor: 'U1' }]);
    });

    it("our own rename's echo is not a user rename (no user, the bot user, or our title repeated right away)", async () => {
      const t = await thread(true);
      await s.setSessionTitle({ threadId: t.id, turnId: 1, title: 'Pico question' });
      await processSlackEvent(titleEvent(t, 'Pico question'));
      await processSlackEvent(titleEvent(t, 'Pico question', 'UBOT'));
      await processSlackEvent(titleEvent(t, 'Pico question', 'U1'));
      expect(await row(t.id)).toMatchObject({ title: 'Pico question', titleBy: 'bot', userRenamedAt: null });
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 2, title: 'Pico power' })).toMatch(/^Conversation titled/);
    });

    it('title events outside DM threads are only logged', async () => {
      const t = await thread(false);
      await processSlackEvent(titleEvent(t, 'Whatever', 'U1'));
      expect(await row(t.id)).toBeUndefined();
    });

    it('session_not_found: creates the session with the title via setStatus; other errors roll back', async () => {
      const t = await thread(true);
      let code = 'session_not_found';
      const remove = fake.addFakeHandler((method, args) => {
        if (method === 'agents.sessions.rename' && args.channel_id === t.channelId) throw fake.fakeSlackError(code);
      });
      try {
        expect(await s.setSessionTitle({ threadId: t.id, turnId: 1, title: 'Pico question' })).toMatch(/^Conversation titled/);
        expect((await calls(t.channelId, 'agents.sessions.setStatus')).map((c) => c.args)).toEqual([{ channel_id: t.channelId, thread_ts: t.threadTs, status: 'processing', title: 'Pico question' }]);
        code = 'ratelimited';
        expect(await s.setSessionTitle({ threadId: t.id, turnId: 2, title: 'Pico power' })).toBe('Not renamed: Slack refused (ratelimited).');
        expect(await row(t.id)).toMatchObject({ title: 'Pico question', titleBy: 'bot', titleTurnId: '1' });
      } finally {
        remove();
      }
      expect(await s.setSessionTitle({ threadId: t.id, turnId: 3, title: 'Pico power' })).toMatch(/^Conversation titled/);
    });

    it('normalizes titles: one line, no markup, ≤ 40 chars', () => {
      expect(s.normalizeSessionTitle('  "Pico W\n pinout <@U123> *question*"  ')).toBe('Pico W pinout question');
      const long = s.normalizeSessionTitle('Comparing the three cheapest microcontroller boards for a robot');
      expect(long.length).toBeLessThanOrEqual(40);
      expect(long).toBe('Comparing the three cheapest…');
      expect(s.normalizeSessionTitle('<!channel>')).toBe('');
    });
  });

  describe('statuses', () => {
    it('finalSessionStatus: closed only for the DM turn that called leave_thread; channel threads stay active', async () => {
      const dm = await thread(true);
      const ch = await thread(false);
      expect(await s.finalSessionStatus(dm.id, 5)).toBe('active');
      expect(await s.requestSessionClose(dm.id, 5)).toBe(true);
      expect(await s.requestSessionClose(ch.id, 5)).toBe(false);
      expect(await s.finalSessionStatus(dm.id, 5)).toBe('closed');
      expect(await s.finalSessionStatus(dm.id, 6)).toBe('active');
      expect(await s.finalSessionStatus(ch.id, 5)).toBe('active');
    });

    it('suspended while a send confirmation from the DM is pending; resolving it sets active', async () => {
      const dm = await thread(true);
      const [p] = await sql<{ id: string }[]>`
        insert into pending_sends (requester_id, thread_id, destination, text, expires_at)
        values ('U1', ${dm.id}, 'C1', 'hi', now() + interval '10 minutes') returning id`;
      expect(await s.finalSessionStatus(dm.id, 1)).toBe('suspended');
      await s.resumeSuspendedSession(dm.id);
      expect(await statuses(dm.channelId)).toEqual([]); // still pending
      const send = await import('../features/send/send.js');
      await send.handleSendCancel({ userId: 'U1', actionId: 'send:cancel', value: p!.id, responseUrl: 'https://hooks.fake/x', body: {} } as any);
      await vi.waitFor(async () => expect(await statuses(dm.channelId)).toEqual(['active']));
      expect(await s.finalSessionStatus(dm.id, 2)).toBe('active');
    });

    it('expired confirmations resume the session too', async () => {
      const dm = await thread(true);
      await sql`insert into pending_sends (requester_id, thread_id, destination, text, expires_at) values ('U1', ${dm.id}, 'C1', 'hi', now() - interval '1 minute')`;
      const send = await import('../features/send/send.js');
      await send.expirePendingSends();
      expect(await statuses(dm.channelId)).toEqual(['active']);
    });

    it('end to end: a DM turn that leaves ends closed; the next message brings it back to processing / active', async () => {
      const dm = await thread(true);
      await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${dm.channelId}, '1.1', ${dm.id}, 'U1', 'thanks, bye'), (${dm.channelId}, '1.2', ${dm.id}, 'U1', 'one more thing')`;
      await scheduler.scheduleMessages(dm.id, 'U1', ['1.1'], true);
      run.mockImplementationOnce(async (turn: any) => {
        await s.requestSessionClose(dm.id, Number(turn.id)); // what leave_thread does in a DM
      });
      await processThreadRun(job({ threadId: dm.id }));
      expect(await statuses(dm.channelId)).toEqual(['processing', 'closed']);
      await scheduler.scheduleMessages(dm.id, 'U1', ['1.2'], true);
      await processThreadRun(job({ threadId: dm.id }));
      expect(await statuses(dm.channelId)).toEqual(['processing', 'closed', 'processing', 'active']);
    });

    it('a crashed turn (stale sweep): its open activity message is removed and the session gets its final status', async () => {
      const dm = await thread(true);
      await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${dm.channelId}, '1.1', ${dm.id}, 'U1', 'send it to #general')`;
      await scheduler.scheduleMessages(dm.id, 'U1', ['1.1'], true);
      const crashed = await scheduler.claimNextPending(dm.id); // the worker died while it ran
      const { recordOpenActivity } = await import('../agent/activity-registry.js');
      await recordOpenActivity(Number(crashed!.id), dm.channelId, '1700000001.000001');
      await sql`insert into pending_sends (requester_id, thread_id, destination, text, expires_at) values ('U1', ${dm.id}, 'C1', 'hi', now() + interval '10 minutes')`;
      await processThreadRun(job({ threadId: dm.id }));
      const chat = (await calls(dm.channelId)).filter((c) => c.method.startsWith('chat.'));
      expect(chat.map((c) => [c.method, c.args.ts])).toEqual([
        ['chat.stopStream', '1700000001.000001'],
        ['chat.delete', '1700000001.000001'],
      ]);
      expect(await statuses(dm.channelId)).toEqual(['suspended']);
      expect(await redis.get(`activity:open:${crashed!.id}`)).toBeNull();
    });

    it('channel threads keep processing / active even if the turn asked to close', async () => {
      const ch = await thread(false);
      await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${ch.channelId}, '1.1', ${ch.id}, 'U1', 'go away')`;
      await scheduler.scheduleMessages(ch.id, 'U1', ['1.1'], true);
      run.mockImplementationOnce(async (turn: any) => {
        expect(await s.requestSessionClose(ch.id, Number(turn.id))).toBe(false);
      });
      await processThreadRun(job({ threadId: ch.id }));
      expect(await statuses(ch.channelId)).toEqual(['processing', 'active']);
    });
  });
});
