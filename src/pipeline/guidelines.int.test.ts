/**
 * Workspace AI-bot guidelines end to end through intake (fake Slack, dedicated test db + redis db, see
 * test-infra.ts). runFrontTurn is stubbed. Skipped automatically when the infra isn't reachable.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { TurnRow } from '../core/types.js';
import { resetTestState, setupTestInfra } from './test-infra.js';

vi.mock('../agent/front.js', () => ({ runFrontTurn: vi.fn() }));

const infra = await setupTestInfra({ name: 'guidelines', redisDb: 14, redisOffset: 3 });

const { sql } = await import('../db/index.js');
const { redis } = await import('../core/redis.js');
const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
const { addFakeHandler, fakeCalls } = await import('../core/slack-fake.js');
const { runFrontTurn } = await import('../agent/front.js');
const scheduler = await import('./scheduler.js');
const debounce = await import('./debounce.js');
const { processDebounce } = await import('./fire.js');
const { processThreadRun } = await import('./thread-run.js');
const { processSlackEvent } = await import('./slack-events.js');
const { stopKey } = await import('./stop.js');
const { renderThreadContext } = await import('../context/thread.js');

const run = vi.mocked(runFrontTurn);
const C = 'C0GUIDE';
const T = '1700000000.000100';
const THREAD = `${C}:${T}`;
let tsCounter = 200;
const nextTs = () => `1700000000.${String(tsCounter++).padStart(6, '0')}`;
const job = <D>(data: D) => ({ data, id: 'test' }) as unknown as Job<D>;
const messageEnvelope = (ev: Record<string, unknown>) =>
  job({ kind: 'event' as const, body: { event_id: `Ev${Math.random()}`, event: { type: 'message', channel: C, channel_type: 'channel', ...ev } } });

async function makeThread(id = THREAD, opts: { engaged?: boolean } = {}) {
  const [channelId, threadTs] = id.split(':');
  await sql`insert into threads (id, channel_id, thread_ts, engaged, last_addressed_at) values (${id}, ${channelId!}, ${threadTs!}, ${opts.engaged ?? true}, now())
            on conflict do nothing`;
}
async function storeMsg(user: string | null, ts: string, text: string, opts: { threadId?: string; botId?: string } = {}) {
  await sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, text) values (${C}, ${ts}, ${opts.threadId ?? THREAD}, ${user}, ${opts.botId ?? null}, ${text})`;
}
async function turns(threadId = THREAD) {
  return sql<{ id: number; authorId: string; status: string; messageTs: string[]; isMention: boolean }[]>`
    select id::int as id, author_id, status, message_ts, is_mention from turns where thread_id = ${threadId} order by id`;
}
const batchSeq = async (threadId: string, authorId: string) => Number((await redis.get(`debounce:seq:${threadId}:${authorId}`)) ?? 0);
const debounceJobs = async () => (await queue(QUEUE.turnDebounce).getJobs(['delayed', 'waiting'])).map((j) => j.data as { threadId: string; authorId: string; seq: number });
const events = async (threadId = THREAD) => (await sql<{ type: string }[]>`select type from thread_events where thread_id = ${threadId} order by id`).map((e) => e.type);

describe.skipIf(!infra)('workspace AI-bot guidelines (intake)', () => {
  beforeEach(async () => {
    await resetTestState();
    await queue(QUEUE.turnDebounce).obliterate({ force: true }).catch(() => {});
    await queue(QUEUE.threadRun).obliterate({ force: true }).catch(() => {});
    run.mockReset();
    run.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await closeQueues();
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  describe('## prefix', () => {
    it('in an engaged two-party thread: not stored, no events, no batch, no turn (also with a bot mention)', async () => {
      await makeThread();
      await storeMsg('U1', T, '<@UBOT> question');
      for (const text of ['## note to self', `  ## <@UBOT> do not answer`, '##']) {
        await processSlackEvent(messageEnvelope({ user: 'U1', text, ts: nextTs(), thread_ts: T }));
      }
      const rows = await sql`select ts from messages where channel_id = ${C}`;
      expect(rows.map((r) => r.ts)).toEqual([T]);
      expect(await events()).toEqual([]);
      expect(await batchSeq(THREAD, 'U1')).toBe(0);
      expect(await debounceJobs()).toEqual([]);
      expect(await turns()).toEqual([]);
      expect((await sql`select messages_since_addressed from threads where id = ${THREAD}`)[0]!.messagesSinceAddressed).toBe(0);
    });

    it('top-level ## mention / DM: no thread row, nothing posted', async () => {
      const ts = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '## <@UBOT> hi', ts }));
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'message', channel: 'D0GUIDE', channel_type: 'im', user: 'U1', text: '## hi', ts: nextTs() } } }));
      expect(await sql`select id from threads`).toHaveLength(0);
      expect(await sql`select ts from messages`).toHaveLength(0);
      expect((await fakeCalls()).filter((c) => c.method.startsWith('chat.'))).toEqual([]);
    });

    it('an edit to ## blanks the stored copy and drops it from the batch (like a deletion)', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> question', ts: root }));
      const f = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'some detail', ts: f, thread_ts: root }));
      await processSlackEvent(
        messageEnvelope({
          subtype: 'message_changed',
          message: { user: 'U1', text: '## some detail', ts: f, thread_ts: root, edited: { ts: '1700000050.000000' } },
          previous_message: { user: 'U1', text: 'some detail', ts: f, thread_ts: root },
        }),
      );
      const [row] = await sql`select text, deleted from messages where ts = ${f}`;
      expect(row).toMatchObject({ text: '', deleted: true });
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: await batchSeq(tid, 'U1') })).toEqual([{ ts: root, reason: 'mention' }]);
      expect(await events(tid)).toContain('message_deleted');
    });

    it('is hidden from rendered context after backfill', async () => {
      const root = '1700000100.000100';
      const tid = `${C}:${root}`;
      const secret = '1700000100.000300';
      const remove = addFakeHandler((method, args) => {
        if (method === 'conversations.replies' && args.channel === C && args.ts === root) {
          return {
            ok: true,
            has_more: false,
            messages: [
              { type: 'message', user: 'U1', text: '<@UBOT> what is up', ts: root, thread_ts: root },
              { type: 'message', user: 'U2', text: 'visible reply', ts: '1700000100.000200', thread_ts: root },
              { type: 'message', user: 'U2', text: '## secret aside', ts: secret, thread_ts: root },
              { type: 'message', user: 'U1', text: '  ##also secret', ts: '1700000100.000400', thread_ts: root },
            ],
          };
        }
        if (method === 'conversations.history' && args.channel === C) {
          return { ok: true, has_more: false, messages: [{ type: 'message', user: 'U3', text: '## channel secret', ts: '1700000099.000100' }, { type: 'message', user: 'U3', text: 'channel visible', ts: '1700000099.000200' }] };
        }
      });
      try {
        await makeThread(tid);
        const ctx = await renderThreadContext(tid, { newMessageTs: [] });
        expect(ctx.history).toContain('visible reply');
        expect(ctx.history).not.toMatch(/secret/);
        expect(ctx.channelContext).toContain('channel visible');
        expect(ctx.channelContext).not.toMatch(/secret/);
        const stored = await sql`select ts from messages where channel_id = ${C} and text like '%secret%'`;
        expect(stored).toHaveLength(0);
      } finally {
        remove();
      }
    });
  });

  describe('@bot !stop', () => {
    it('runs the native stop handler and never starts a turn', async () => {
      await makeThread();
      await storeMsg('U1', T, '<@UBOT> research X');
      await scheduler.scheduleMessages(THREAD, 'U1', ['1700000000.000150'], true); // a pending turn of U1
      await debounce.addToBatch(THREAD, 'U1', '1700000000.000160', 'direct'); // and an open batch
      const ts = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT>  !STOP ', ts, thread_ts: T }));

      expect((await turns()).map((t) => t.status)).toEqual(['cancelled']);
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U1', seq: await batchSeq(THREAD, 'U1') })).toBeNull();
      expect((await sql`select engaged from threads where id = ${THREAD}`)[0]!.engaged).toBe(false);
      expect(Number(await redis.get(stopKey(THREAD)))).toBeGreaterThan(Date.now() - 5000);
      const calls = await fakeCalls();
      expect(calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args)).toEqual([{ channel: C, thread_ts: T, text: 'Stopped.' }]);
      expect(calls.filter((c) => c.method === 'agents.sessions.setStatus').map((c) => c.args.status)).toEqual(['active']);
      expect(await events()).toEqual(expect.arrayContaining(['disengaged', 'session_stopped']));
      // No turn, no batch from the !stop message itself.
      expect((await debounceJobs()).filter((j) => j.seq > 1)).toEqual([]);
      await processThreadRun(job({ threadId: THREAD }));
      expect(run).not.toHaveBeenCalled();
    });

    it('in a DM without a mention, and at channel top level (harmless)', async () => {
      const dmTs = nextTs();
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'message', channel: 'D0GUIDE', channel_type: 'im', user: 'U1', text: '!stop', ts: dmTs } } }));
      const top = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> !stop', ts: top }));
      const posts = (await fakeCalls()).filter((c) => c.method === 'chat.postMessage').map((c) => c.args);
      expect(posts).toEqual([
        { channel: 'D0GUIDE', thread_ts: dmTs, text: 'Stopped.' },
        { channel: C, thread_ts: top, text: 'Stopped.' },
      ]);
      expect(await debounceJobs()).toEqual([]);
      expect(await sql`select id from turns`).toHaveLength(0);
    });
  });

  describe('group ping on a top-level trigger', () => {
    it('replies in a new top-level message (no group ping) and runs the turn in its thread', async () => {
      const src = nextTs();
      const text = '<!subteam^S1|@team> <@UBOT> help with the deploy?';
      await processSlackEvent(messageEnvelope({ user: 'U1', text, ts: src }));

      const posts = (await fakeCalls()).filter((c) => c.method === 'chat.postMessage');
      expect(posts).toHaveLength(1);
      const post = posts[0]!.args;
      expect(post.thread_ts).toBeUndefined();
      expect(post.channel).toBe(C);
      expect(post.text).toContain('<@U1>');
      expect(post.text).toContain(`p${src.replace('.', '')}`); // permalink to the source message
      expect(post.text).not.toMatch(/<!(subteam|channel|here|everyone)/);

      // The original group-ping thread is not engaged; the conversation lives under the bot's new message.
      expect(await sql`select id from threads where id = ${`${C}:${src}`}`).toHaveLength(0);
      const [th] = await sql<{ id: string; threadTs: string; engaged: boolean }[]>`select id, thread_ts, engaged from threads`;
      expect(th!.engaged).toBe(true);
      const newThread = th!.id;
      const [srcRow] = await sql`select thread_id, text from messages where ts = ${src}`;
      expect(srcRow).toMatchObject({ threadId: newThread, text });
      expect(await events(newThread)).toEqual(['group_redirect', 'message']);

      // Debounce → turn in the new thread.
      const [dj] = await debounceJobs();
      expect(dj).toMatchObject({ threadId: newThread, authorId: 'U1' });
      await processDebounce(job(dj!));
      expect(await turns(newThread)).toEqual([expect.objectContaining({ authorId: 'U1', status: 'pending', messageTs: [src], isMention: true })]);
      let seen: TurnRow | undefined;
      run.mockImplementationOnce(async (turn) => {
        seen = turn;
      });
      await processThreadRun(job({ threadId: newThread }));
      expect(seen).toMatchObject({ threadId: newThread, messageTs: [src] });
      // Status indicator goes to the new thread.
      const status = (await fakeCalls()).filter((c) => c.method === 'agents.sessions.setStatus').map((c) => c.args.thread_ts);
      expect(status.length).toBeGreaterThan(0);
      expect(new Set(status)).toEqual(new Set([th!.threadTs]));

      // The agent sees the question as the new message, and the bot's root as history; later turns keep the question.
      const first = await renderThreadContext(newThread, { newMessageTs: [src] });
      expect(first.newMessages).toContain('help with the deploy?');
      expect(first.history).toContain('replying here');
      const f = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'any update?', ts: f, thread_ts: th!.threadTs }));
      expect(await debounce.takeBatch({ threadId: newThread, authorId: 'U1', seq: await batchSeq(newThread, 'U1') })).toEqual([{ ts: f, reason: 'direct' }]);
      const later = await renderThreadContext(newThread, { newMessageTs: [f] });
      expect(later.history).toContain('help with the deploy?');
      expect(later.newMessages).toContain('any update?');

      // A redelivered event doesn't post a second redirect.
      await processSlackEvent(messageEnvelope({ user: 'U1', text, ts: src }));
      expect((await fakeCalls()).filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    });

    it('@channel/@here count as group pings; thread replies and DMs are answered in place', async () => {
      const src = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<!here> <@UBOT> hi', ts: src }));
      expect((await fakeCalls()).filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
      await redis.del('slack:fake:calls');

      await makeThread();
      const reply = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U2', text: '<!subteam^S1> <@UBOT> hi', ts: reply, thread_ts: T }));
      expect((await fakeCalls()).filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U2', seq: 1 })).toEqual([{ ts: reply, reason: 'mention' }]);
    });
  });

  describe('<> prefix', () => {
    it('two-party follow-up starting with <> gets no turn but is stored; with a bot mention it is a normal mention', async () => {
      await makeThread();
      await storeMsg('U1', T, '<@UBOT> question');
      await storeMsg('UBOT', '1700000000.000150', 'answer', { botId: 'BBOT' });
      const quiet = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '&lt;&gt; just thinking out loud', ts: quiet, thread_ts: T }));
      expect(await batchSeq(THREAD, 'U1')).toBe(0);
      expect(await debounceJobs()).toEqual([]);
      expect((await sql`select text from messages where ts = ${quiet}`)[0]!.text).toBe('&lt;&gt; just thinking out loud');

      const loud = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '&lt;&gt; <@UBOT> hi', ts: loud, thread_ts: T }));
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U1', seq: await batchSeq(THREAD, 'U1') })).toEqual([{ ts: loud, reason: 'mention' }]);
    });

    it('a DM starting with <> gets no reply', async () => {
      const ts = nextTs();
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'message', channel: 'D0GUIDE', channel_type: 'im', user: 'U1', text: '<> note', ts } } }));
      expect(await debounceJobs()).toEqual([]);
      expect(await sql`select ts from messages where ts = ${ts}`).toHaveLength(1);
    });
  });
});
