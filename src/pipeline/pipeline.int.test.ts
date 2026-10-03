/**
 * Integration tests against local Postgres/Redis (dedicated test db + redis db, see test-infra.ts). runFrontTurn is
 * stubbed; Slack runs in SLACK_FAKE mode. Skipped automatically when the infra isn't reachable.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { StoredMessage, TurnRow } from '../core/types.js';
import type { TurnIO } from '../agent/front.js';
import { resetTestState, setupTestInfra } from './test-infra.js';

vi.mock('../agent/front.js', () => ({ runFrontTurn: vi.fn() }));

const infra = await setupTestInfra();

// Dynamically imported after env setup.
const { sql } = await import('../db/index.js');
const { redis } = await import('../core/redis.js');
const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
const { fakeCalls } = await import('../core/slack-fake.js');
const { runFrontTurn } = await import('../agent/front.js');
const scheduler = await import('./scheduler.js');
const { processThreadRun } = await import('./thread-run.js');
const debounce = await import('./debounce.js');
const { processDebounce, gateImpl } = await import('./fire.js');
const { processSlackEvent } = await import('./slack-events.js');
const { acquireLock, threadLockKey } = await import('./lock.js');

const run = vi.mocked(runFrontTurn);
const C = 'C0TEST';
const T = '1700000000.000100';
const THREAD = `${C}:${T}`;
let tsCounter = 200;
const nextTs = () => `1700000000.${String(tsCounter++).padStart(6, '0')}`;
const job = <T>(data: T) => ({ data, id: 'test' }) as unknown as Job<T>;

async function makeThread(id = THREAD, opts: { engaged?: boolean } = {}) {
  const [channelId, threadTs] = id.split(':');
  await sql`insert into threads (id, channel_id, thread_ts, engaged, last_addressed_at) values (${id}, ${channelId!}, ${threadTs!}, ${opts.engaged ?? true}, now())
            on conflict do nothing`;
}
async function storeMsg(user: string, ts: string, text = 'hi', threadId = THREAD) {
  await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${C}, ${ts}, ${threadId}, ${user}, ${text})`;
}
async function turns(threadId = THREAD) {
  return sql<{ id: number; authorId: string; status: string; phase: string | null; messageTs: string[]; isMention: boolean; kind: string }[]>`
    select id::int as id, author_id, status, phase, message_ts, is_mention, kind from turns where thread_id = ${threadId} order by id`;
}
async function threadRunJobs() {
  return (await queue(QUEUE.threadRun).getJobs(['waiting', 'delayed', 'prioritized'])).map((j) => j.data);
}
const messageEnvelope = (ev: Record<string, unknown>) => job({ kind: 'event' as const, body: { event_id: `Ev${Math.random()}`, event: { type: 'message', channel: C, channel_type: 'channel', ...ev } } });

describe.skipIf(!infra)('pipeline integration', () => {
  beforeEach(async () => {
    await resetTestState();
    run.mockReset();
    run.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await closeQueues();
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  describe('scheduling', () => {
    it('requestTurn creates a pending synthesis turn and enqueues thread-run', async () => {
      await makeThread();
      const id = await scheduler.requestTurn({ threadId: THREAD, authorId: 'U1', kind: 'synthesis', cardId: 7 });
      expect(typeof id).toBe('number');
      const [t] = await turns();
      expect(t).toMatchObject({ id, kind: 'synthesis', status: 'pending', authorId: 'U1' });
      expect(await threadRunJobs()).toContainEqual({ threadId: THREAD });
    });

    it('same author extends their pending turn; different authors get separate turns', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1700000000.000300'], false);
      await scheduler.scheduleMessages(THREAD, 'U1', ['1700000000.000200'], true);
      await scheduler.scheduleMessages(THREAD, 'U2', ['1700000000.000400'], false);
      const ts = await turns();
      expect(ts).toHaveLength(2);
      expect(ts[0]).toMatchObject({ authorId: 'U1', messageTs: ['1700000000.000200', '1700000000.000300'], isMention: true });
      expect(ts[1]).toMatchObject({ authorId: 'U2', messageTs: ['1700000000.000400'] });
    });

    it('pushes to the inbox only for a same-author running turn in phase tools', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], false);
      const turn = (await scheduler.claimNextPending(THREAD))!;
      expect(turn).toMatchObject({ status: 'running', phase: 'tools' });

      expect(await scheduler.scheduleMessages(THREAD, 'U1', ['1.2'], false)).toEqual({ kind: 'inbox', turnId: turn.id });
      expect((await scheduler.scheduleMessages(THREAD, 'U2', ['1.3'], false)).kind).toBe('turn');

      await scheduler.setPhase(turn.id, 'final');
      const r = await scheduler.scheduleMessages(THREAD, 'U1', ['1.4'], false);
      expect(r.kind).toBe('turn');
      // Once the author has a waiting turn, later messages queue behind it even if the phase flips back.
      await scheduler.setPhase(turn.id, 'tools');
      expect(await scheduler.scheduleMessages(THREAD, 'U1', ['1.5'], false)).toEqual(r);
      const inbox = await sql`select message_ts from thread_inbox where turn_id = ${turn.id}`;
      expect(inbox.map((x) => x.messageTs)).toEqual(['1.2']);
    });

    it('drainInbox returns stored messages once; finishTurn moves undrained rows into a new pending turn', async () => {
      await makeThread();
      await storeMsg('U1', '1.2', 'second');
      await storeMsg('U1', '1.3', 'third');
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], false);
      const turn = (await scheduler.claimNextPending(THREAD))!;
      await scheduler.pushToRunningTurn(THREAD, 'U1', ['1.2'], false);
      const drained = await scheduler.drainInbox(turn.id, THREAD);
      expect(drained.map((m) => m.text)).toEqual(['second']);
      expect(await scheduler.drainInbox(turn.id, THREAD)).toEqual([]);
      await scheduler.pushToRunningTurn(THREAD, 'U1', ['1.3'], true);
      const follow = await scheduler.finishTurn(turn.id, 'done');
      expect(follow).not.toBeNull();
      const ts = await turns();
      expect(ts[0]).toMatchObject({ status: 'done', phase: null });
      expect(ts[0]!.messageTs).toEqual(expect.arrayContaining(['1.1', '1.2']));
      expect(ts[1]).toMatchObject({ id: follow, status: 'pending', messageTs: ['1.3'], isMention: true });
    });

    it('a deleted message leaves pending turns; an emptied turn is cancelled', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1', '1.2'], false);
      await scheduler.removeMessageFromTurns(THREAD, '1.1');
      expect((await turns())[0]).toMatchObject({ status: 'pending', messageTs: ['1.2'] });
      await scheduler.removeMessageFromTurns(THREAD, '1.2');
      expect((await turns())[0]).toMatchObject({ status: 'cancelled' });
    });
  });

  describe('thread-run', () => {
    it('runs pending turns sequentially in id order, with status indicator only for mentions', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], true);
      await scheduler.scheduleMessages(THREAD, 'U2', ['1.2'], false);
      let concurrent = 0;
      let maxConcurrent = 0;
      const order: string[] = [];
      run.mockImplementation(async (turn: TurnRow, io: TurnIO) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(`${turn.authorId}:${io.isMention}`);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
      });
      // Two workers racing for the same thread: only the lock holder runs turns.
      await Promise.all([processThreadRun(job({ threadId: THREAD })), processThreadRun(job({ threadId: THREAD }))]);
      expect(order).toEqual(['U1:true', 'U2:false']);
      expect(maxConcurrent).toBe(1);
      expect((await turns()).map((t) => t.status)).toEqual(['done', 'done']);
      const statusCalls = (await fakeCalls()).filter((c) => c.method === 'assistant.threads.setStatus');
      expect(statusCalls.map((c) => c.args.status)).toEqual(['is thinking…', '']);
      const events = await sql`select type from thread_events where thread_id = ${THREAD} order by id`;
      expect(events.map((e) => e.type)).toEqual(['turn_started', 'turn_finished', 'turn_started', 'turn_finished']);
    });

    it('messages pushed mid-turn are drained by the agent; leftovers become the next turn', async () => {
      await makeThread();
      await storeMsg('U1', '1.2', 'more');
      await storeMsg('U1', '1.3', 'late');
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], false);
      const seen: StoredMessage[][] = [];
      run
        .mockImplementationOnce(async (_turn, io) => {
          await scheduler.scheduleMessages(THREAD, 'U1', ['1.2'], false); // arrives during tools phase
          seen.push(await io.drainInbox());
          await io.setPhase('final');
          await scheduler.pushToRunningTurn(THREAD, 'U1', ['1.3'], false); // rejected: final phase
          await scheduler.scheduleMessages(THREAD, 'U1', ['1.3'], false); // → new pending turn
        })
        .mockImplementationOnce(async (turn) => {
          seen.push([{ text: turn.messageTs.join(',') } as StoredMessage]);
        });
      await processThreadRun(job({ threadId: THREAD }));
      expect(seen.map((s) => s.map((m) => m.text))).toEqual([['more'], ['1.3']]);
      expect((await turns()).map((t) => t.status)).toEqual(['done', 'done']);
    });

    it('on error: marks the turn errored and posts a one-time error message', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], false);
      run.mockRejectedValue(new Error('boom'));
      await processThreadRun(job({ threadId: THREAD }));
      const [t] = await turns();
      expect(t!.status).toBe('error');
      const posts = (await fakeCalls()).filter((c) => c.method === 'chat.postMessage');
      expect(posts).toHaveLength(1);
      expect(posts[0]!.args).toMatchObject({ channel: C, thread_ts: T, text: 'Something broke, try again.' });
      const [key] = await sql`select key from idempotency_keys`;
      expect(key!.key).toBe(`chat.postMessage:turn-error:${t!.id}`);
    });

    it('returns immediately when another worker holds the lock, and re-enqueues after release', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], false);
      const lock = (await acquireLock(threadLockKey(THREAD), 5000))!;
      await processThreadRun(job({ threadId: THREAD }));
      expect(run).not.toHaveBeenCalled();
      await lock.release();
      await processThreadRun(job({ threadId: THREAD }));
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('a holder marks stale running turns (crashed worker) as errored before continuing', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], false);
      await scheduler.claimNextPending(THREAD); // "crashed" while running
      await scheduler.scheduleMessages(THREAD, 'U2', ['1.2'], false);
      await processThreadRun(job({ threadId: THREAD }));
      expect((await turns()).map((t) => t.status)).toEqual(['error', 'done']);
    });
  });

  describe('debounce', () => {
    it('only the latest job takes the batch; deletions can empty it', async () => {
      await makeThread();
      await debounce.addToBatch(THREAD, 'U1', '1.1', 'gate');
      await debounce.addToBatch(THREAD, 'U1', '1.2', 'mention');
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U1', seq: 1 })).toBeNull();
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U1', seq: 2 })).toEqual([
        { ts: '1.1', reason: 'gate' },
        { ts: '1.2', reason: 'mention' },
      ]);
      await debounce.addToBatch(THREAD, 'U1', '1.3', 'gate');
      await debounce.removeFromBatch(THREAD, 'U1', '1.3');
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U1', seq: 3 })).toBeNull();
      const delayed = await queue(QUEUE.turnDebounce).getJobs(['delayed']);
      expect(delayed.map((j) => j.data.seq)).toEqual([3]); // superseded jobs removed
    });

    it('uses the long window while the thread has active runs', async () => {
      await makeThread();
      expect(await debounce.addToBatch(THREAD, 'U1', '1.1', 'gate')).toBe(1000);
      await sql`insert into subagents (id, thread_id, owner_id, title) values ('sa_1', ${THREAD}, 'U1', 't')`;
      await sql`insert into runs (subagent_id, thread_id, instructions, status) values ('sa_1', ${THREAD}, 'x', 'running')`;
      expect(await debounce.addToBatch(THREAD, 'U1', '1.2', 'gate')).toBe(3000);
    });

    it('fire: gated batch runs the gate and schedules on yes, drops on no', async () => {
      await makeThread();
      await storeMsg('U2', '1.5', 'what about NZ?');
      const gate = vi.spyOn(gateImpl, 'run').mockResolvedValueOnce({ respond: false, raw: 'no', latencyMs: 5 });
      await debounce.addToBatch(THREAD, 'U2', '1.5', 'gate');
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 1 }));
      expect(await turns()).toHaveLength(0);
      gate.mockResolvedValueOnce({ respond: true, raw: 'yes', latencyMs: 5 });
      await debounce.addToBatch(THREAD, 'U2', '1.5', 'gate');
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 2 }));
      expect(await turns()).toMatchObject([{ authorId: 'U2', messageTs: ['1.5'], isMention: false }]);
      const decisions = await sql`select payload from thread_events where thread_id = ${THREAD} and type = 'gate_decision' order by id`;
      expect(decisions.map((d) => d.payload.decision)).toEqual(['no', 'yes']);
      gate.mockRestore();
    });
  });

  describe('intake (slack-events)', () => {
    it('mention engages a thread, stores the message and starts a batch; app_mention is ignored', async () => {
      const ts = nextTs();
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'app_mention', channel: C, user: 'U1', text: '<@UBOT> hi', ts } } }));
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hi', ts }));
      const [th] = await sql`select * from threads where id = ${`${C}:${ts}`}`;
      expect(th).toMatchObject({ engaged: true, messagesSinceAddressed: 0 });
      const [m] = await sql`select text from messages where ts = ${ts}`;
      expect(m!.text).toBe('<@UBOT> hi');
      expect(await debounce.takeBatch({ threadId: `${C}:${ts}`, authorId: 'U1', seq: 1 })).toEqual([{ ts, reason: 'mention' }]);
    });

    it('follow-ups: two-party → direct; third person → gate; mentioning someone else → skipped; bots → stored only', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> question', ts: root }));
      const f1 = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'and also', ts: f1, thread_ts: root }));
      await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', text: 'answer', ts: nextTs(), thread_ts: root }));
      const f2 = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'interesting', ts: f2, thread_ts: root }));
      await processSlackEvent(messageEnvelope({ user: 'U2', text: '<@U3> thoughts?', ts: nextTs(), thread_ts: root }));
      const u1 = await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 2 });
      expect(u1).toEqual([
        { ts: root, reason: 'mention' },
        { ts: f1, reason: 'direct' },
      ]);
      // U2's seq: the skipped message never entered the batch, so seq is still 1.
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 1 })).toEqual([{ ts: f2, reason: 'gate' }]);
      const [row] = await sql`select count(*)::int as count from messages where thread_id = ${tid}`;
      expect(row!.count).toBe(5);
    });

    it('ignores follow-ups in threads the bot is not part of and disengages after idle messages', async () => {
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'random', ts: nextTs(), thread_ts: '1600000000.000001' }));
      expect(await sql`select 1 from threads`).toHaveLength(0);

      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hey', ts: root }));
      for (let i = 0; i < 11; i++) {
        await processSlackEvent(messageEnvelope({ user: i % 2 ? 'U2' : 'U3', text: `chat ${i}`, ts: nextTs(), thread_ts: root }));
      }
      const [th] = await sql`select engaged from threads where id = ${tid}`;
      expect(th!.engaged).toBe(false);
      const evs = await sql`select payload from thread_events where thread_id = ${tid} and type = 'disengaged'`;
      expect(evs[0]!.payload).toEqual({ reason: 'idle' });
    });

    it('"stop" disengages but is still delivered', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> research X', ts: root }));
      const stop = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'shut up', ts: stop, thread_ts: root }));
      expect((await sql`select engaged from threads where id = ${tid}`)[0]!.engaged).toBe(false);
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 1 })).toEqual([{ ts: stop, reason: 'stop' }]);
    });

    it('edits update the stored copy; deletions clear it and remove it from the batch', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> one', ts: root, files: [{ id: 'F1', name: 'a.png' }] }));
      await processSlackEvent(
        messageEnvelope({ subtype: 'message_changed', message: { user: 'U1', text: '<@UBOT> one (edited)', ts: root, edited: { ts: '1700000001.000000' } } }),
      );
      expect((await sql`select text, edited_at from messages where ts = ${root}`)[0]).toMatchObject({ text: '<@UBOT> one (edited)' });
      await processSlackEvent(messageEnvelope({ subtype: 'message_deleted', deleted_ts: root, previous_message: { user: 'U1', ts: root } }));
      const [m] = await sql`select text, files, deleted from messages where ts = ${root}`;
      expect(m).toEqual({ text: '', files: [], deleted: true });
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 1 })).toBeNull();
      const types = (await sql`select type from thread_events where thread_id = ${tid} order by id`).map((e) => e.type);
      expect(types).toEqual(['message', 'message_edited', 'message_deleted']);
    });

    it('out-of-order processing: edit or delete before the original message', async () => {
      const root = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hi', ts: root }));
      const a = nextTs();
      await processSlackEvent(messageEnvelope({ subtype: 'message_changed', message: { user: 'U1', text: 'v2', ts: a, thread_ts: root, edited: { ts: '1700000009.000000' } } }));
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'v1', ts: a, thread_ts: root }));
      expect((await sql`select text from messages where ts = ${a}`)[0]!.text).toBe('v2');

      const b = nextTs();
      await processSlackEvent(messageEnvelope({ subtype: 'message_deleted', deleted_ts: b, previous_message: { user: 'U1', ts: b, thread_ts: root } }));
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'secret', ts: b, thread_ts: root }));
      expect((await sql`select text, deleted from messages where ts = ${b}`)[0]).toEqual({ text: '', deleted: true });
      const batch = await debounce.takeBatch({ threadId: `${C}:${root}`, authorId: 'U1', seq: 2 });
      expect(batch?.map((x) => x.ts)).toEqual([root, a]);
    });

    it('DMs: each top-level message is its own thread and always runs', async () => {
      const ts = nextTs();
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'hello', ts } } }));
      const [th] = await sql`select is_dm, engaged from threads where id = ${`D1:${ts}`}`;
      expect(th).toEqual({ isDm: true, engaged: true });
      expect(await debounce.takeBatch({ threadId: `D1:${ts}`, authorId: 'U1', seq: 1 })).toEqual([{ ts, reason: 'dm' }]);
    });
  });
});
