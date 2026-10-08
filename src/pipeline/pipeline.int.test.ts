/**
 * Integration tests against local Postgres/Redis (dedicated test db + redis db, see test-infra.ts). runFrontTurn is
 * stubbed; Slack runs in SLACK_FAKE mode. Skipped automatically when the infra isn't reachable.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      const statusCalls = (await fakeCalls()).filter((c) => c.method.endsWith('.setStatus'));
      expect(statusCalls.map((c) => [c.method, c.args.status, c.args.initiator_user_id])).toEqual([
        ['agents.sessions.setStatus', 'processing', 'U1'],
        ['agents.sessions.setStatus', 'active', 'U1'],
      ]);
      expect((await fakeCalls()).some((c) => c.method.startsWith('assistant.threads.'))).toBe(false); // deprecated API
      const events = await sql`select type from thread_events where thread_id = ${THREAD} and type <> 'turn_timing' order by id`;
      expect(events.map((e) => e.type)).toEqual(['turn_started', 'turn_finished', 'turn_started', 'turn_finished']);
    });

    it('session status: cleared even when the turn fails; agents.sessions errors are tolerated', async () => {
      const { addFakeHandler, fakeSlackError } = await import('../core/slack-fake.js');
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], true);
      run.mockRejectedValueOnce(new Error('boom'));
      await processThreadRun(job({ threadId: THREAD }));
      const statuses = async () => (await fakeCalls()).filter((c) => c.method.endsWith('.setStatus')).map((c) => `${c.method}:${c.args.status}`);
      const normal = ['agents.sessions.setStatus:processing', 'agents.sessions.setStatus:active'];
      expect(await statuses()).toEqual(normal);

      await redis.del('slack:fake:calls');
      let code = 'unknown_method';
      const remove = addFakeHandler((method) => {
        if (method === 'agents.sessions.setStatus') throw fakeSlackError(code);
      });
      try {
        await scheduler.scheduleMessages(THREAD, 'U1', ['1.2'], true);
        await processThreadRun(job({ threadId: THREAD }));
        // Failures are logged and tolerated (no fallback): same calls, the turn goes on.
        expect(await statuses()).toEqual(normal);
        expect((await turns()).map((t) => t.status)).toEqual(['error', 'done']);
        // Expected errors (e.g. not in channel) are just skipped.
        await redis.del('slack:fake:calls');
        code = 'channel_not_found';
        await scheduler.scheduleMessages(THREAD, 'U1', ['1.3'], true);
        await processThreadRun(job({ threadId: THREAD }));
        expect(await statuses()).toEqual(normal);
      } finally {
        remove();
      }
      expect((await turns()).map((t) => t.status)).toEqual(['error', 'done', 'done']);
    });

    describe('status activity', () => {
      const statusCalls = async () =>
        (await fakeCalls()).filter((c) => c.method.endsWith('.setStatus')).map((c) => (c.method === 'agents.sessions.setStatus' ? `session:${c.args.status}` : `legacy:${c.method}`));

      const dmEnvelope = (ts: string, text = 'hello') => job({ kind: 'event' as const, body: { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text, ts } } });

      it('DM: status shown at intake (before the debounce window), adopted by the turn, cleared once at the end', async () => {
        const ts = nextTs();
        const tid = `D1:${ts}`;
        await processSlackEvent(dmEnvelope(ts));
        await vi.waitFor(async () => expect(await statusCalls()).toEqual(['session:processing']));
        await vi.waitFor(async () => expect(await redis.exists(`status:intake:${tid}`)).toBe(1));
        await processDebounce(job({ threadId: tid, authorId: 'U1', seq: 1 }));
        run.mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 20));
        });
        await processThreadRun(job({ threadId: tid }));
        expect(await statusCalls()).toEqual(['session:processing', 'session:active']);
        expect(await redis.exists(`status:intake:${tid}`)).toBe(0);
      });

      it('DM deleted within the debounce window: the intake status is cleared', async () => {
        const ts = nextTs();
        const tid = `D1:${ts}`;
        await processSlackEvent(dmEnvelope(ts));
        await vi.waitFor(async () => expect(await redis.exists(`status:intake:${tid}`)).toBe(1));
        await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'message', subtype: 'message_deleted', channel: 'D1', channel_type: 'im', deleted_ts: ts, previous_message: { user: 'U1', ts } } } }));
        await processDebounce(job({ threadId: tid, authorId: 'U1', seq: 1 }));
        expect(await statusCalls()).toEqual(['session:processing', 'session:active']);
        expect(await turns(tid)).toHaveLength(0);
      });

      it('no intake status while a turn holds the thread lock (that turn owns the indicator)', async () => {
        const ts = nextTs();
        const lock = (await acquireLock(threadLockKey(`D1:${ts}`), 5000))!;
        await processSlackEvent(dmEnvelope(ts));
        await new Promise((r) => setTimeout(r, 50));
        expect(await statusCalls()).toEqual([]);
        await lock.release();
      });

      it('unmentioned turn that replies directly: zero status calls', async () => {
        await makeThread();
        await scheduler.scheduleMessages(THREAD, 'U2', ['1.1'], false);
        run.mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 20)); // reply/react only: setActivity is never called
        });
        await processThreadRun(job({ threadId: THREAD }));
        expect(await statusCalls()).toEqual([]);
      });

      it('unmentioned turn with a lookup: status set on the lookup, cleared at the end (also on failure)', async () => {
        await makeThread();
        await scheduler.scheduleMessages(THREAD, 'U2', ['1.1'], false);
        let duringTurn: string[] = [];
        run.mockImplementationOnce(async (_turn, io) => {
          expect(await statusCalls()).toEqual([]);
          io.setActivity!('Searching Slack…');
          await new Promise((r) => setTimeout(r, 50));
          duringTurn = await statusCalls();
        });
        await processThreadRun(job({ threadId: THREAD }));
        expect(duringTurn).toEqual(['session:processing']);
        expect(await statusCalls()).toEqual(['session:processing', 'session:active']);
        const set = (await fakeCalls()).find((c) => c.method === 'agents.sessions.setStatus')!;
        expect(set.args).toEqual({ channel_id: C, thread_ts: T, status: 'processing', initiator_user_id: 'U2' });

        await redis.del('slack:fake:calls');
        await scheduler.scheduleMessages(THREAD, 'U2', ['1.2'], false);
        run.mockImplementationOnce(async (_turn, io) => {
          io.setActivity!('Reading the page…');
          await new Promise((r) => setTimeout(r, 20));
          throw new Error('boom');
        });
        await processThreadRun(job({ threadId: THREAD }));
        expect(await statusCalls()).toEqual(['session:processing', 'session:active']);
      });

      it('mention turn: processing from the start, again after a reply stream released the session, active at the end', async () => {
        await makeThread();
        await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], true);
        run.mockImplementationOnce(async (_turn, io) => {
          // Shown without blocking the turn: the model call starts right away.
          await vi.waitFor(async () => expect(await statusCalls()).toEqual(['session:processing']));
          io.setActivity!('Searching the web…'); // already processing: no call
          io.setActivity!('Reading the page…');
          await new Promise((r) => setTimeout(r, 50));
          io.sessionReleased!(); // a reply's chat.stopStream set the session active
          io.setActivity!('Digging in…');
          io.setActivity!('Searching Slack…');
          await new Promise((r) => setTimeout(r, 50));
        });
        await processThreadRun(job({ threadId: THREAD }));
        expect(await statusCalls()).toEqual(['session:processing', 'session:processing', 'session:active']);
      });

      it('after the native stop, activity no longer re-sets the status', async () => {
        await makeThread();
        await scheduler.scheduleMessages(THREAD, 'U2', ['1.1'], false);
        run.mockImplementationOnce(async (_turn, io) => {
          await processSlackEvent(
            job({ kind: 'event' as const, body: { event_id: 'EvStop', event: { type: 'agent_session_stopped', channel: C, thread_ts: T, user: 'U2', event_ts: '1700000099.000002' } } }),
          );
          io.setActivity!('Searching Slack…');
          await new Promise((r) => setTimeout(r, 50));
        });
        await processThreadRun(job({ threadId: THREAD }));
        // Only the stop handler's `active`; the stopped turn never showed anything.
        expect(await statusCalls()).toEqual(['session:active']);
      });
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

  describe('native stop (agent_session_stopped)', () => {
    const stopEnvelope = (user = 'U1', eventTs = '1700000099.000001') =>
      job({
        kind: 'event' as const,
        body: { event_id: `Ev${Math.random()}`, event: { type: 'agent_session_stopped', channel: C, thread_ts: T, user, event_ts: eventTs, streaming_message_ts: ['1700000000.000900'] } },
      });

    it('stops the current response only: drops the user\'s pending turns, keeps runs and engagement, sets active, confirms once', async () => {
      const { stopKey } = await import('./stop.js');
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], true);
      await scheduler.scheduleMessages(THREAD, 'U2', ['1.2'], false);
      await debounce.addToBatch(THREAD, 'U1', '1.3', 'direct');
      const [card] = await sql`insert into cards (thread_id, channel_id) values (${THREAD}, ${C}) returning id::int as id`;
      await sql`insert into subagents (id, thread_id, owner_id, title, status) values ('sa_q', ${THREAD}, 'U1', 'queued one', 'running'), ('sa_r', ${THREAD}, 'U2', 'running one', 'running')`;
      await sql`insert into runs (subagent_id, thread_id, card_id, instructions, status) values ('sa_q', ${THREAD}, ${card!.id}, 'x', 'queued'), ('sa_r', ${THREAD}, ${card!.id}, 'y', 'running')`;

      await processSlackEvent(stopEnvelope());

      expect((await turns()).map((t) => [t.authorId, t.status])).toEqual([
        ['U1', 'cancelled'],
        ['U2', 'pending'],
      ]);
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U1', seq: 1 })).toBeNull();
      const runs = await sql`select subagent_id, status, cancel_requested from runs order by id`;
      expect(runs.map((r) => [r.subagentId, r.status, r.cancelRequested])).toEqual([
        ['sa_q', 'queued', false],
        ['sa_r', 'running', false],
      ]);
      expect((await sql`select engaged from threads where id = ${THREAD}`)[0]!.engaged).toBe(true);
      expect(Number(await redis.get(stopKey(THREAD)))).toBeGreaterThan(Date.now() - 5000);
      const calls = await fakeCalls();
      expect(calls.filter((c) => c.method === 'agents.sessions.setStatus').map((c) => c.args)).toEqual([
        { channel_id: C, thread_ts: T, status: 'active', initiator_user_id: 'U1' },
      ]);
      expect(calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args)).toEqual([{ channel: C, thread_ts: T, text: 'Stopped.' }]);
      const types = (await sql`select type from thread_events where thread_id = ${THREAD} order by id`).map((e) => e.type);
      expect(types).toContain('session_stopped');
      expect(types).not.toContain('disengaged');

      // A redelivered event (same event_ts) doesn't post a second confirmation.
      await processSlackEvent(stopEnvelope());
      expect((await fakeCalls()).filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    });

    it('the running turn sees stopRequested; turns started afterwards do not', async () => {
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], true);
      await scheduler.scheduleMessages(THREAD, 'U2', ['1.2'], true);
      const seen: boolean[] = [];
      run
        .mockImplementationOnce(async (_turn, io) => {
          seen.push(await io.stopRequested!());
          await new Promise((r) => setTimeout(r, 5)); // the stop must land after the turn's start (ms resolution)
          await processSlackEvent(stopEnvelope('U1'));
          seen.push(await io.stopRequested!());
        })
        .mockImplementationOnce(async (_turn, io) => {
          seen.push(await io.stopRequested!());
        });
      await processThreadRun(job({ threadId: THREAD }));
      expect(seen).toEqual([false, true, false]);
      expect((await turns()).map((t) => t.status)).toEqual(['done', 'done']);
    });

    it('works without a stored thread (nothing to cancel) and ignores malformed events', async () => {
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'agent_session_stopped', channel: 'D9', user: 'U1' } } }));
      expect(await fakeCalls()).toHaveLength(0);
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'agent_session_stopped', channel: 'D9', thread_ts: '1.5', user: 'U1', event_ts: '2.0' } } }));
      expect((await fakeCalls()).map((c) => c.method)).toEqual(['agents.sessions.setStatus', 'chat.postMessage']);
    });
  });

  describe('agent container context (app_context_changed)', () => {
    const ctxEnvelope = (entities: unknown[], authorizations: unknown[] = [{ user_id: 'UBOT', is_bot: true }, { user_id: 'U7' }]) =>
      job({ kind: 'event' as const, body: { event_id: `Ev${Math.random()}`, authorizations, event: { type: 'app_context_changed', context: { entities } } } });

    it('stores the viewed channel per user and hands it to that user\'s next DM turn only', async () => {
      await processSlackEvent(ctxEnvelope([{ type: 'slack#/types/channel_id', value: 'CSHIP' }, { type: 'slack#/types/channel_id', value: 'CMORE' }]));
      expect(await redis.get('view:ctx:U7')).toBe('CSHIP');
      // An event naming only the bot can't be attributed: ignored.
      await processSlackEvent(ctxEnvelope([{ type: 'slack#/types/channel_id', value: 'CX' }], [{ user_id: 'UBOT' }]));
      expect(await redis.get('view:ctx:UBOT')).toBeNull();

      const dmThread = `D7:1700000000.000500`;
      await makeThread(dmThread);
      await scheduler.scheduleMessages(dmThread, 'U7', ['1.1'], true);
      const seen: (string | null | undefined)[] = [];
      run.mockImplementation(async (_turn, io) => void seen.push(io.viewingChannelId));
      await processThreadRun(job({ threadId: dmThread }));
      await makeThread();
      await scheduler.scheduleMessages(THREAD, 'U7', ['1.3'], true);
      await processThreadRun(job({ threadId: THREAD }));
      expect(seen).toEqual(['CSHIP', null]);

      // Closing the container / no channel entity clears it.
      await processSlackEvent(ctxEnvelope([]));
      expect(await redis.get('view:ctx:U7')).toBeNull();
    });

    it('agent_session_title_changed makes no Slack calls (a user rename is only recorded, see agent-session.int.test.ts)', async () => {
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'agent_session_title_changed', channel: 'D1', thread_ts: '1.1', title: 'x' } } }));
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'agent_session_title_changed', channel: 'D1', thread_ts: '1.1', title: 'x', user: 'U1' } } }));
      expect((await fakeCalls()).filter((c) => c.method !== 'auth.test')).toHaveLength(0);
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
      const gate = vi.spyOn(gateImpl, 'run').mockResolvedValueOnce({ respond: false, raw: 'no', latencyMs: 5, model: 'test' });
      await debounce.addToBatch(THREAD, 'U2', '1.5', 'gate');
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 1 }));
      expect(await turns()).toHaveLength(0);
      gate.mockResolvedValueOnce({ respond: true, raw: 'yes', latencyMs: 5, model: 'test' });
      await debounce.addToBatch(THREAD, 'U2', '1.5', 'gate');
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 2 }));
      expect(await turns()).toMatchObject([{ authorId: 'U2', messageTs: ['1.5'], isMention: false }]);
      expect((await sql`select addressed, gated from turns`)[0]).toEqual({ addressed: false, gated: true });
      const decisions = await sql`select payload from thread_events where thread_id = ${THREAD} and type = 'gate_decision' order by id`;
      expect(decisions.map((d) => d.payload.decision)).toEqual(['no', 'yes']);
      gate.mockRestore();
    });
  });

  describe('gate thresholds and addressed turns', () => {
    it('partner batches use the low threshold and become addressed turns; cooling threads the high one', async () => {
      await makeThread();
      await storeMsg('U2', '1.6', 'whats nd studio?');
      const gate = vi.spyOn(gateImpl, 'run').mockResolvedValue({ respond: true, raw: '0.7', probability: 0.7, latencyMs: 5, model: 'test' });
      await debounce.addToBatch(THREAD, 'U2', '1.6', 'partner');
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 1 }));
      expect(gate.mock.calls[0]![0]).toMatchObject({ threshold: 0.65 });
      expect(gate.mock.calls[0]![0].note).toMatch(/just talking with/);
      const [t] = await sql`select addressed, gated, is_mention from turns where thread_id = ${THREAD}`;
      expect(t).toEqual({ addressed: true, gated: true, isMention: false });

      await sql`update threads set last_addressed_at = now() - interval '4 hours', last_bot_reply_at = null where id = ${THREAD}`;
      await storeMsg('U3', '1.7', 'anyone?');
      await debounce.addToBatch(THREAD, 'U3', '1.7', 'gate');
      await processDebounce(job({ threadId: THREAD, authorId: 'U3', seq: 1 }));
      expect(gate.mock.calls[1]![0]).toMatchObject({ threshold: 0.9 });
      expect(gate.mock.calls[1]![0].note).toBeUndefined();
      const decisions = await sql`select payload from thread_events where thread_id = ${THREAD} and type = 'gate_decision' order by id`;
      expect(decisions.map((d) => [d.payload.threshold, d.payload.partner ?? false, d.payload.cooling ?? false])).toEqual([
        [0.65, true, false],
        [0.9, false, true],
      ]);
      const ts = await sql`select addressed from turns where thread_id = ${THREAD} and author_id = 'U3'`;
      expect(ts[0]!.addressed).toBe(false);
      gate.mockRestore();
    });

    it("someone else's answer to the bot gets the partner threshold, its own note, and becomes an addressed turn", async () => {
      await makeThread();
      await storeMsg('U2', '1.65', 'go for it');
      const gate = vi.spyOn(gateImpl, 'run').mockResolvedValue({ respond: true, raw: '0.7', probability: 0.7, latencyMs: 5, model: 'test' });
      await sql`update threads set last_addressed_at = now() - interval '8 hours', last_bot_reply_at = now() - interval '8 hours' where id = ${THREAD}`;
      await debounce.addToBatch(THREAD, 'U2', '1.65', 'answer_other');
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 1 }));
      expect(gate.mock.calls[0]![0]).toMatchObject({ threshold: 0.65 });
      expect(gate.mock.calls[0]![0].note).toMatch(/question or an offer for another person/);
      const [d] = await sql`select payload from thread_events where thread_id = ${THREAD} and type = 'gate_decision'`;
      expect(d!.payload).toMatchObject({ partner: true, answersOther: true, cooling: true, threshold: 0.65 });
      expect((await sql`select addressed, gated from turns where thread_id = ${THREAD}`)[0]).toEqual({ addressed: true, gated: true });
      gate.mockRestore();
    });

    it("the bot's recent partner after a bystander's remark: intake → intermediate threshold, softer note, a gated (not addressed) turn", async () => {
      const { noteBotReply } = await import('./store.js');
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> why does my bot poll so often', ts: root }));
      await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 1 });
      const botTs = nextTs();
      await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', text: 'it polls the history every 2s per channel.', ts: botTs, thread_ts: root }));
      await noteBotReply(tid, { ts: botTs, partnerId: 'U1', awaitsReply: false });
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'the widget team had the same issue', ts: nextTs(), thread_ts: root }));
      await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 1 });
      const q = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'whats the widget team?', ts: q, thread_ts: root }));

      const gate = vi.spyOn(gateImpl, 'run').mockResolvedValue({ respond: true, raw: '0.7', probability: 0.7, latencyMs: 5, model: 'test' });
      await processDebounce(job({ threadId: tid, authorId: 'U1', seq: 2 }));
      expect(gate).toHaveBeenCalledTimes(1);
      expect(gate.mock.calls[0]![0]).toMatchObject({ threshold: 0.65 });
      expect(gate.mock.calls[0]![0].note).toMatch(/a few minutes ago in this thread; someone else has written since/);
      const [d] = await sql`select payload from thread_events where thread_id = ${tid} and type = 'gate_decision'`;
      expect(d!.payload).toMatchObject({ recentPartner: true, threshold: 0.65, messageTs: [q] });
      expect(d!.payload.partner).toBeUndefined();
      expect((await sql`select addressed, gated, message_ts from turns where thread_id = ${tid} and author_id = 'U1' and status = 'pending'`)[0]).toEqual({
        addressed: false,
        gated: true,
        messageTs: [q],
      });
      gate.mockRestore();
    });

    it('direct (answer to the bot) batches skip the gate and are addressed', async () => {
      await makeThread();
      await storeMsg('U1', '1.8', 'build it');
      const gate = vi.spyOn(gateImpl, 'run');
      await debounce.addToBatch(THREAD, 'U1', '1.8', 'direct');
      await processDebounce(job({ threadId: THREAD, authorId: 'U1', seq: 1 }));
      expect(gate).not.toHaveBeenCalled();
      expect(await turns()).toMatchObject([{ authorId: 'U1', messageTs: ['1.8'], isMention: false }]);
      expect((await sql`select addressed, gated from turns`)[0]).toEqual({ addressed: true, gated: false });
      gate.mockRestore();
    });

    it('inbox leftovers that needed the gate go back through it; mentions stay a direct turn', async () => {
      await makeThread();
      await storeMsg('U1', '1.2', 'yes make it');
      await storeMsg('U1', '1.3', '<@UBOT> and this');
      await scheduler.scheduleMessages(THREAD, 'U1', ['1.1'], true);
      const turn = (await scheduler.claimNextPending(THREAD))!;
      await scheduler.pushToRunningTurn(THREAD, 'U1', ['1.2'], false, [{ ts: '1.2', reason: 'gate' }]);
      expect(await scheduler.finishTurn(turn.id, 'done')).toBeNull();
      expect((await turns()).filter((t) => t.status === 'pending')).toHaveLength(0);
      expect(await debounce.takeBatch({ threadId: THREAD, authorId: 'U1', seq: 1 })).toEqual([{ ts: '1.2', reason: 'gate' }]);
      const evs = await sql`select payload from thread_events where thread_id = ${THREAD} and type = 'inbox_regated'`;
      expect(evs[0]!.payload).toMatchObject({ turnId: turn.id, messageTs: ['1.2'] });

      await scheduler.scheduleMessages(THREAD, 'U1', ['1.4'], true);
      const turn2 = (await scheduler.claimNextPending(THREAD))!;
      await scheduler.pushToRunningTurn(THREAD, 'U1', ['1.2', '1.3'], true, [
        { ts: '1.2', reason: 'gate' },
        { ts: '1.3', reason: 'mention' },
      ]);
      const follow = await scheduler.finishTurn(turn2.id, 'done');
      expect(follow).not.toBeNull();
      expect((await turns()).find((t) => t.id === follow)).toMatchObject({ status: 'pending', messageTs: ['1.2', '1.3'], isMention: true });
    });
  });

  describe('turn hold: results / scheduled turns wait for pending human messages', () => {
    const order = () => run.mock.calls.map(([t]) => `${t.kind}:${t.authorId}`);
    const events = async (type: string) => (await sql`select payload from thread_events where thread_id = ${THREAD} and type = ${type} order by id`).map((e) => e.payload);
    const saved = { max: 0, poll: 0 };
    beforeEach(async () => {
      const { limits } = await import('../config.js');
      saved.max = limits.turnHoldMaxMs;
      saved.poll = limits.turnHoldPollMs;
    });
    afterEach(async () => {
      const { limits } = await import('../config.js');
      (limits as any).turnHoldMaxMs = saved.max;
      (limits as any).turnHoldPollMs = saved.poll;
    });

    it('a results turn waits while a newer message is in debounce and at the gate; the user turn then runs first', async () => {
      await makeThread();
      await storeMsg('U2', '1.5', 'can you also open a PR for the parser fix?');
      const synth = await scheduler.requestTurn({ threadId: THREAD, authorId: 'U1', kind: 'synthesis', cardId: 7 });
      await debounce.addToBatch(THREAD, 'U2', '1.5', 'gate');

      // In debounce: held, with a delayed re-check.
      await processThreadRun(job({ threadId: THREAD }));
      expect(run).not.toHaveBeenCalled();
      expect((await turns()).map((t) => [t.kind, t.status])).toEqual([['synthesis', 'pending']]);
      const delayed = await queue(QUEUE.threadRun).getJobs(['delayed']);
      expect(delayed.map((j) => j.data)).toContainEqual({ threadId: THREAD });
      expect(await events('turn_held')).toEqual([{ turnId: synth, maxMs: saved.max }]);

      // At the gate (batch taken, decision in flight): still held.
      const gate = vi.spyOn(gateImpl, 'run').mockImplementation(async () => {
        expect(await debounce.hasPendingHumanInput(THREAD)).toBe(true);
        await processThreadRun(job({ threadId: THREAD }));
        expect(run).not.toHaveBeenCalled();
        return { respond: true, raw: 'yes', latencyMs: 5, model: 'test' };
      });
      await queue(QUEUE.threadRun).drain(true);
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 1 }));
      expect(gate).toHaveBeenCalledTimes(1);
      expect(await debounce.hasPendingHumanInput(THREAD)).toBe(false);
      expect(await threadRunJobs()).toContainEqual({ threadId: THREAD }); // woken by the user turn + the fire

      // The message became its own user turn: it runs before the results turn that waited for it.
      await processThreadRun(job({ threadId: THREAD }));
      expect(order()).toEqual(['user:U2', 'synthesis:U1']);
      expect((await turns()).map((t) => t.status)).toEqual(['done', 'done']);
      expect(await events('turn_hold_ended')).toEqual([expect.objectContaining({ turnId: synth, kind: 'synthesis', timedOut: false })]);
      expect(await events('turn_yielded')).toEqual([{ turnId: synth, to: synth + 1 }]);
      gate.mockRestore();
    });

    it('the gate says no: the held turn runs once the decision is in, with no user turn', async () => {
      await makeThread();
      await storeMsg('U2', '1.5', 'lol same');
      await scheduler.requestTurn({ threadId: THREAD, authorId: 'U1', kind: 'scheduled' });
      await debounce.addToBatch(THREAD, 'U2', '1.5', 'gate');
      await processThreadRun(job({ threadId: THREAD }));
      expect(run).not.toHaveBeenCalled();
      const gate = vi.spyOn(gateImpl, 'run').mockResolvedValueOnce({ respond: false, raw: 'no', latencyMs: 5, model: 'test' });
      await queue(QUEUE.threadRun).drain(true);
      await processDebounce(job({ threadId: THREAD, authorId: 'U2', seq: 1 }));
      expect(await threadRunJobs()).toContainEqual({ threadId: THREAD }); // the fire woke the held thread
      await processThreadRun(job({ threadId: THREAD }));
      expect(order()).toEqual(['scheduled:U1']);
      gate.mockRestore();
    });

    it('the wait is bounded: after turnHoldMaxMs the turn runs anyway (the "Still being handled" note covers it)', async () => {
      const { limits } = await import('../config.js');
      (limits as any).turnHoldMaxMs = 150;
      (limits as any).turnHoldPollMs = 50;
      await makeThread();
      await storeMsg('U2', '1.5', 'one more thing');
      const synth = await scheduler.requestTurn({ threadId: THREAD, authorId: 'U1', kind: 'synthesis', cardId: 7 });
      await debounce.addToBatch(THREAD, 'U2', '1.5', 'gate'); // never fired in this test
      await processThreadRun(job({ threadId: THREAD }));
      expect(run).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 200));
      await processThreadRun(job({ threadId: THREAD }));
      expect(order()).toEqual(['synthesis:U1']);
      expect(await events('turn_hold_ended')).toEqual([expect.objectContaining({ turnId: synth, timedOut: true })]);
    });

    it('user turns already queued go first; ones queued later wait behind the results turn', async () => {
      await makeThread();
      await scheduler.requestTurn({ threadId: THREAD, authorId: 'U1', kind: 'synthesis', cardId: 7 });
      await scheduler.scheduleMessages(THREAD, 'U2', ['1.5'], true);
      run.mockImplementation(async (turn: TurnRow) => {
        if (turn.authorId === 'U2') await scheduler.scheduleMessages(THREAD, 'U3', ['1.6'], true); // arrives mid-turn
      });
      await processThreadRun(job({ threadId: THREAD }));
      expect(order()).toEqual(['user:U2', 'synthesis:U1', 'user:U3']);
    });

    it('nothing pending: a results turn runs at once, no hold events', async () => {
      await makeThread();
      await scheduler.requestTurn({ threadId: THREAD, authorId: 'U1', kind: 'synthesis', cardId: 7 });
      await processThreadRun(job({ threadId: THREAD }));
      expect(order()).toEqual(['synthesis:U1']);
      expect(await events('turn_held')).toEqual([]);
      expect(await events('turn_hold_ended')).toEqual([]);
    });
  });

  describe('ingress + interactions', () => {
    it('dedupes Events API retries on event_id', async () => {
      const { handleEnvelope } = await import('../ingress/main.js');
      const env = { ack: async () => {}, envelope_id: 'e1', type: 'events_api', body: { event_id: 'EvDUP1', event: { type: 'message' } } };
      await handleEnvelope(env);
      await handleEnvelope({ ...env, envelope_id: 'e2', retry_num: 1, retry_reason: 'timeout' });
      await handleEnvelope({ ack: async () => {}, envelope_id: 'e3', type: 'slash_commands', body: { command: '/x', user_id: 'U1' } });
      const jobs = await queue(QUEUE.slackEvents).getJobs(['waiting']);
      expect(jobs.map((j) => j.data.kind).sort()).toEqual(['event', 'slash']);
    });

    it('dispatches block_actions, view submissions and slash commands to registered handlers', async () => {
      const { registerAction } = await import('../core/actions.js');
      const seen: { actionId: string; value?: string; userId: string; channelId?: string }[] = [];
      registerAction('ptest:', async (ctx) => void seen.push({ actionId: ctx.actionId, value: ctx.value, userId: ctx.userId, channelId: ctx.channelId }));
      registerAction('slash:/ptest', async (ctx) => void seen.push({ actionId: ctx.actionId, value: ctx.value, userId: ctx.userId, channelId: ctx.channelId }));
      await processSlackEvent(
        job({ kind: 'interactive' as const, body: { type: 'block_actions', user: { id: 'U1' }, channel: { id: C }, message: { ts: '1.1' }, actions: [{ action_id: 'ptest:go', value: '42' }] } }),
      );
      await processSlackEvent(job({ kind: 'interactive' as const, body: { type: 'view_submission', user: { id: 'U2' }, view: { callback_id: 'ptest:modal', private_metadata: 'pm' } } }));
      await processSlackEvent(job({ kind: 'slash' as const, body: { command: '/ptest', user_id: 'U3', channel_id: C, text: 'hello' } }));
      expect(seen).toEqual([
        { actionId: 'ptest:go', value: '42', userId: 'U1', channelId: C },
        { actionId: 'ptest:modal', value: 'pm', userId: 'U2', channelId: undefined },
        { actionId: 'slash:/ptest', value: 'hello', userId: 'U3', channelId: C },
      ]);
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

    it('follow-ups: two-party → partner (gated, low threshold); third person → gate; mentioning someone else → skipped; bots → stored only', async () => {
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
        { ts: f1, reason: 'partner' },
      ]);
      // U2's seq: the skipped message never entered the batch, so seq is still 1.
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 1 })).toEqual([{ ts: f2, reason: 'gate' }]);
      const [row] = await sql`select count(*)::int as count from messages where thread_id = ${tid}`;
      expect(row!.count).toBe(5);
    });

    it('a follow-up whose only other mention is a "Sent using @…" context footer is not skipped as mentioning someone else', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> question', ts: root }));
      const f1 = nextTs();
      const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: 'Sent using <@UAPP|Claude>' }] };
      await processSlackEvent(
        messageEnvelope({
          user: 'U1',
          text: 'and the other one?\n\nSent using <@UAPP|Claude>',
          blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'and the other one?' }] }] }, footer],
          ts: f1,
          thread_ts: root,
        }),
      );
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 2 })).toEqual([
        { ts: root, reason: 'mention' },
        { ts: f1, reason: 'partner' },
      ]);
    });

    it("answering the bot's question skips the gate once; the bot's conversation partner is a partner until someone else writes", async () => {
      const { noteBotReply } = await import('./store.js');
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> question', ts: root }));
      await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 1 });
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'me too', ts: nextTs(), thread_ts: root })); // not two-party any more
      const botTs = nextTs();
      await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', text: 'want me to dig deeper?', ts: botTs, thread_ts: root }));
      await noteBotReply(tid, { ts: botTs, partnerId: 'U1', awaitsReply: true });
      // Idle and even disengaged: the answer still runs, without the gate.
      await sql`update threads set engaged = false, last_addressed_at = now() - interval '2 days' where id = ${tid}`;
      const a = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'yes', ts: a, thread_ts: root }));
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 2 })).toEqual([{ ts: a, reason: 'direct' }]);
      const [th] = await sql`select engaged, awaits_reply_from from threads where id = ${tid}`;
      expect(th).toEqual({ engaged: true, awaitsReplyFrom: null });
      // The flag is taken: U1's next message is a partner follow-up (nobody else wrote since the bot's reply).
      const b = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'and the docs', ts: b, thread_ts: root }));
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 3 })).toEqual([{ ts: b, reason: 'partner' }]);
      // Someone else's message in between: U1 is only a recent partner (intermediate threshold) while the bot's
      // reply is at most limits.recentPartnerMs old, then back to the normal gate.
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'lol', ts: nextTs(), thread_ts: root }));
      const c = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'anyway', ts: c, thread_ts: root }));
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 4 })).toEqual([{ ts: c, reason: 'recent_partner' }]);
      await sql`update threads set last_bot_reply_at = now() - interval '11 minutes' where id = ${tid}`;
      const c2 = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'anyway, later', ts: c2, thread_ts: root }));
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 5 })).toEqual([{ ts: c2, reason: 'gate' }]);
      // An answer that @mentions someone else is not for the bot.
      await noteBotReply(tid, { ts: nextTs(), partnerId: 'U1', awaitsReply: true });
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@U2> what do you think?', ts: nextTs(), thread_ts: root }));
      expect((await sql`select awaits_reply_from from threads where id = ${tid}`)[0]!.awaitsReplyFrom).toBe('U1');
    });

    it("someone else's first message after the bot's question to another person is a likely answer (gated, not direct)", async () => {
      const { noteBotReply } = await import('./store.js');
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> question', ts: root }));
      await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 1 });
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'same here', ts: nextTs(), thread_ts: root }));
      await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 1 });
      const botTs = nextTs();
      await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', text: 'want me to write it up?', ts: botTs, thread_ts: root }));
      await noteBotReply(tid, { ts: botTs, partnerId: 'U1', awaitsReply: true });
      const a = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'go for it', ts: a, thread_ts: root }));
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 2 })).toEqual([{ ts: a, reason: 'answer_other' }]);
      // Not consumed: the person the bot asked still answers without the gate.
      expect((await sql`select awaits_reply_from from threads where id = ${tid}`)[0]!.awaitsReplyFrom).toBe('U1');
      // Only the first message after the bot's reply counts.
      const b = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U3', text: 'nice', ts: b, thread_ts: root }));
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U3', seq: 1 })).toEqual([{ ts: b, reason: 'gate' }]);
      const c = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'yes', ts: c, thread_ts: root }));
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: 2 })).toEqual([{ ts: c, reason: 'direct' }]);
    });

    it('idle for hours only cools a thread (stricter gate); it disengages after a week, or after 25 messages', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hey', ts: root }));
      await sql`update threads set last_addressed_at = now() - interval '5 hours' where id = ${tid}`;
      const a = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'so what now', ts: a, thread_ts: root }));
      expect((await sql`select engaged from threads where id = ${tid}`)[0]!.engaged).toBe(true);
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 1 })).toEqual([{ ts: a, reason: 'gate' }]);
      // A recent bot reply (e.g. a synthesis turn) counts as activity even when nobody addressed the bot for 8 days.
      await sql`update threads set last_addressed_at = now() - interval '8 days', last_bot_reply_at = now() - interval '1 hour' where id = ${tid}`;
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'still here', ts: nextTs(), thread_ts: root }));
      expect((await sql`select engaged from threads where id = ${tid}`)[0]!.engaged).toBe(true);
      await sql`update threads set last_bot_reply_at = now() - interval '8 days' where id = ${tid}`;
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'hello?', ts: nextTs(), thread_ts: root }));
      expect((await sql`select engaged from threads where id = ${tid}`)[0]!.engaged).toBe(false);
    });

    it('ignores follow-ups in threads the bot is not part of and disengages after idle messages', async () => {
      await processSlackEvent(messageEnvelope({ user: 'U1', text: 'random', ts: nextTs(), thread_ts: '1600000000.000001' }));
      expect(await sql`select 1 from threads`).toHaveLength(0);

      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hey', ts: root }));
      for (let i = 0; i < 25; i++) {
        await processSlackEvent(messageEnvelope({ user: i % 2 ? 'U2' : 'U3', text: `chat ${i}`, ts: nextTs(), thread_ts: root }));
      }
      expect((await sql`select engaged from threads where id = ${tid}`)[0]!.engaged).toBe(true);
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'chat 25', ts: nextTs(), thread_ts: root }));
      const [th] = await sql`select engaged from threads where id = ${tid}`;
      expect(th!.engaged).toBe(false);
      const evs = await sql`select payload from thread_events where thread_id = ${tid} and type = 'disengaged'`;
      expect(evs[0]!.payload).toEqual({ reason: 'idle' });
    });

    it('"shut up" is an ordinary message: it goes through the gate and does not disengage by itself', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> research X', ts: root }));
      const stop = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U2', text: 'shut up', ts: stop, thread_ts: root }));
      expect((await sql`select engaged from threads where id = ${tid}`)[0]!.engaged).toBe(true);
      expect(await debounce.takeBatch({ threadId: tid, authorId: 'U2', seq: 1 })).toEqual([{ ts: stop, reason: 'gate' }]);
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
      expect(types).toEqual(['message', 'message_edited', 'message_deleted', 'root_deleted']);
    });

    it('message_changed with the same text and files (a thread root re-sent as replies arrive) is not an edit', async () => {
      const root = nextTs();
      const tid = `${C}:${root}`;
      const edited = { ts: '1700000001.000000' };
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> one', ts: root, files: [{ id: 'F1', name: 'a.png' }] }));
      await processSlackEvent(messageEnvelope({ subtype: 'message_changed', message: { user: 'U1', text: '<@UBOT> one!', ts: root, edited, files: [{ id: 'F1', name: 'a.png' }] } }));
      // Slack re-sends the (once edited) root every time a reply is added: same text, same files.
      for (let i = 1; i <= 3; i++) {
        await processSlackEvent(
          messageEnvelope({ subtype: 'message_changed', message: { user: 'U1', text: '<@UBOT> one!', ts: root, edited, reply_count: i, files: [{ id: 'F1', name: 'a.png' }] } }),
        );
      }
      const edits = async () => (await sql`select 1 from thread_events where thread_id = ${tid} and type = 'message_edited'`).length;
      expect(await edits()).toBe(1);
      // A change in the files is an edit.
      await processSlackEvent(messageEnvelope({ subtype: 'message_changed', message: { user: 'U1', text: '<@UBOT> one!', ts: root, edited, files: [] } }));
      expect(await edits()).toBe(2);
      expect((await sql`select text, files from messages where ts = ${root}`)[0]).toEqual({ text: '<@UBOT> one!', files: [] });
    });

    it('deleting the thread root blocks posting into it, cancels pending turns and stops the running turn', async () => {
      const { slackCall, ThreadGoneError } = await import('../core/slack.js');
      const { stopRequestedSince } = await import('./stop.js');
      const root = nextTs();
      const tid = `${C}:${root}`;
      const before = Date.now() - 1;
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> help me', ts: root }));
      await sql`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${tid}, 'U1', true, ${[root]}, 'pending')`;
      await processSlackEvent(messageEnvelope({ subtype: 'message_deleted', deleted_ts: root, previous_message: { user: 'U1', ts: root } }));
      expect((await sql`select status from turns where thread_id = ${tid}`).map((t) => t.status)).toEqual(['cancelled']);
      expect((await sql`select root_deleted_at is not null as gone, engaged from threads where id = ${tid}`)[0]).toEqual({ gone: true, engaged: false });
      expect(await stopRequestedSince(tid, before)).toBe(true);
      await expect(slackCall('chat.postMessage', { channel: C, thread_ts: root, text: 'hi' })).rejects.toBeInstanceOf(ThreadGoneError);
      await expect(slackCall('chat.startStream', { channel: C, thread_ts: root, markdown_text: 'hi' })).rejects.toBeInstanceOf(ThreadGoneError);
      // Other threads and non-posting calls are unaffected.
      await expect(slackCall('chat.postMessage', { channel: C, thread_ts: nextTs(), text: 'hi' })).resolves.toMatchObject({ ok: true });
      await expect(slackCall('chat.update', { channel: C, ts: root, text: 'x' })).resolves.toMatchObject({ ok: true });
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

    describe('intake hygiene', () => {
      const dm = (channel: string, user: string, ts: string, text = 'hello') =>
        job({ kind: 'event' as const, body: { event_id: `Ev${Math.random()}`, event: { type: 'message', channel, channel_type: 'im', user, text, ts } } });

      it('Slackbot system messages are ignored everywhere (not stored, no thread, no batch)', async () => {
        const ts = nextTs();
        await processSlackEvent(dm('D0SLACKBOT', 'USLACKBOT', ts, 'You were added to the user group @staff'));
        const root = nextTs();
        await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hi', ts: root }));
        await processSlackEvent(messageEnvelope({ user: 'USLACKBOT', text: 'reminder: <@UBOT> stand-up', ts: nextTs(), thread_ts: root }));
        expect(await sql`select 1 from threads where id = ${`D0SLACKBOT:${ts}`}`).toHaveLength(0);
        expect(await sql`select 1 from messages where user_id = 'USLACKBOT'`).toHaveLength(0);
        expect(await debounce.takeBatch({ threadId: `D0SLACKBOT:${ts}`, authorId: 'USLACKBOT', seq: 1 })).toBeNull();
      });

      it('a DM whose other party is a bot or app user starts nothing; the verdict is cached per channel', async () => {
        const { addFakeHandler } = await import('../core/slack-fake.js');
        let lookups = 0;
        const remove = addFakeHandler((method, args) => {
          if (method !== 'users.info' || args.user !== 'UAPPUSER') return undefined;
          lookups++;
          return { ok: true, user: { id: 'UAPPUSER', name: 'someapp', is_bot: false, is_app_user: true, profile: {} } };
        });
        try {
          const a = nextTs();
          await processSlackEvent(dm('D0APP', 'UAPPUSER', a));
          await processSlackEvent(dm('D0APP', 'UAPPUSER', nextTs()));
          expect(await sql`select 1 from threads where channel_id = 'D0APP'`).toHaveLength(0);
          expect(await debounce.takeBatch({ threadId: `D0APP:${a}`, authorId: 'UAPPUSER', seq: 1 })).toBeNull();
          expect(lookups).toBe(1);
          // A person's DM still works.
          const b = nextTs();
          await processSlackEvent(dm('D0HUMAN', 'U1', b));
          expect(await debounce.takeBatch({ threadId: `D0HUMAN:${b}`, authorId: 'U1', seq: 1 })).toEqual([{ ts: b, reason: 'dm' }]);
        } finally {
          remove();
        }
      });

      it('restricted_action_read_only_channel marks the channel: no more turns start there', async () => {
        const { addFakeHandler, fakeSlackError } = await import('../core/slack-fake.js');
        const { slackCall, isChannelReadOnly } = await import('../core/slack.js');
        const remove = addFakeHandler((method, args) => {
          if (method === 'chat.postMessage' && args.channel === 'D0RO') throw fakeSlackError('restricted_action_read_only_channel');
        });
        try {
          await expect(slackCall('chat.postMessage', { channel: 'D0RO', text: 'hi' })).rejects.toThrow();
          expect(await isChannelReadOnly('D0RO')).toBe(true);
          expect(await isChannelReadOnly('D0OTHER')).toBe(false);
          const ts = nextTs();
          await processSlackEvent(dm('D0RO', 'U1', ts));
          expect(await debounce.takeBatch({ threadId: `D0RO:${ts}`, authorId: 'U1', seq: 1 })).toBeNull();
        } finally {
          remove();
        }
      });
    });

    it('DMs: each top-level message is its own thread and always runs', async () => {
      const ts = nextTs();
      await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'hello', ts } } }));
      const [th] = await sql`select is_dm, engaged from threads where id = ${`D1:${ts}`}`;
      expect(th).toEqual({ isDm: true, engaged: true });
      expect(await debounce.takeBatch({ threadId: `D1:${ts}`, authorId: 'U1', seq: 1 })).toEqual([{ ts, reason: 'dm' }]);
    });
  });

  describe('reactions (reaction_added / reaction_removed)', () => {
    const reactionEnvelope = (type: 'reaction_added' | 'reaction_removed', user: string, reaction: string, ts: string, channel = C) =>
      job({ kind: 'event' as const, body: { event_id: `Ev${Math.random()}`, event: { type, user, reaction, item: { type: 'message', channel, ts }, item_user: 'U1', event_ts: nextTs() } } });

    it('keeps stored reactions current, logs events, never starts a turn, ignores unknown messages', async () => {
      await makeThread();
      const ts = nextTs();
      await storeMsg('U1', ts, 'shipped it');
      await processSlackEvent(reactionEnvelope('reaction_added', 'U2', 'tada', ts));
      await processSlackEvent(reactionEnvelope('reaction_added', 'U3', 'tada', ts));
      await processSlackEvent(reactionEnvelope('reaction_added', 'U3', 'tada', ts)); // redelivery
      await processSlackEvent(reactionEnvelope('reaction_added', 'UBOT', 'eyes', ts));
      await processSlackEvent(reactionEnvelope('reaction_removed', 'U2', 'tada', ts));
      const [row] = await sql<any[]>`select reactions from messages where channel_id = ${C} and ts = ${ts}`;
      expect(row.reactions).toEqual([
        { name: 'tada', users: ['U3'], count: 1 },
        { name: 'eyes', users: ['UBOT'], count: 1 },
      ]);
      const events = await sql<any[]>`select type, actor, payload from thread_events where thread_id = ${THREAD} and type like 'reaction%' order by id`;
      expect(events.map((e) => `${e.type}:${e.actor}:${e.payload.emoji}`)).toEqual([
        'reaction_added:U2:tada',
        'reaction_added:U3:tada',
        'reaction_added:U3:tada',
        'reaction_added:UBOT:eyes',
        'reaction_removed:U2:tada',
      ]);
      // Concurrent events on one message don't lose updates.
      await Promise.all(['U4', 'U5', 'U6', 'U7'].map((u) => processSlackEvent(reactionEnvelope('reaction_added', u, 'fire', ts))));
      const [row2] = await sql<any[]>`select reactions from messages where channel_id = ${C} and ts = ${ts}`;
      expect(row2.reactions.find((r: any) => r.name === 'fire')).toMatchObject({ count: 4 });

      // Reactions on messages we don't store, and on non-messages, are ignored.
      await processSlackEvent(reactionEnvelope('reaction_added', 'U2', 'eyes', '1700000999.000001', 'C0OTHER'));
      await processSlackEvent(job({ kind: 'event' as const, body: { event_id: 'EvFile', event: { type: 'reaction_added', user: 'U2', reaction: 'x', item: { type: 'file', file: 'F1' } } } }));
      expect(await turns()).toHaveLength(0);
      expect(await threadRunJobs()).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
    });
  });
});
