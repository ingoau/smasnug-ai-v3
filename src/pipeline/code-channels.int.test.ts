/**
 * Code channels through intake (docs/code-channels.md, Inside the channel): the `${channel}:0` conversation, thread
 * replies, parent-agent posts, adoption, reopening, status and stop. Fake Slack, dedicated test db + redis db
 * (test-infra.ts); runFrontTurn and the gate are stubbed. Skipped when the infra isn't reachable.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { resetTestState, setupTestInfra } from './test-infra.js';

vi.hoisted(() => {
  process.env.CODE_CHANNELS = '1';
});
vi.mock('../agent/front.js', () => ({ runFrontTurn: vi.fn() }));

const infra = await setupTestInfra({ name: 'codechannels', redisDb: 11, redisOffset: 5 });

const { sql } = await import('../db/index.js');
const { redis } = await import('../core/redis.js');
const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
const { addFakeHandler, fakeCalls } = await import('../core/slack-fake.js');
const { runFrontTurn } = await import('../agent/front.js');
const debounce = await import('./debounce.js');
const { processDebounce, gateImpl } = await import('./fire.js');
const { processThreadRun } = await import('./thread-run.js');
const { processSlackEvent } = await import('./slack-events.js');
const { stopKey } = await import('./stop.js');
const store = await import('../features/code-channels/store.js');
const { setCodeChannelsDisabled } = await import('../features/code-channels/settings.js');
const { parentMessageMetadata } = await import('../features/code-channels/parent-message.js');
const { acceptOwnParentPost } = await import('./code-channel-intake.js');

const run = vi.mocked(runFrontTurn);
const C = 'C0CODE';
const CONV = `${C}:0`;
const PARENT = 'C0PARENT:1700000000.000001';
let tsCounter = 100;
const nextTs = () => `1700000000.${String(tsCounter++).padStart(6, '0')}`;
const job = <D,>(data: D) => ({ data, id: 'test' }) as unknown as Job<D>;
const messageEnvelope = (ev: Record<string, unknown>, channel = C) =>
  job({ kind: 'event' as const, body: { event_id: `Ev${Math.random()}`, event: { type: 'message', channel, channel_type: 'channel', ...ev } } });
const batchSeq = async (threadId: string, authorId: string) => Number((await redis.get(`debounce:seq:${threadId}:${authorId}`)) ?? 0);
const takeBatch = async (threadId: string, authorId: string) => debounce.takeBatch({ threadId, authorId, seq: await batchSeq(threadId, authorId) });
const debounceJobs = async () => (await queue(QUEUE.turnDebounce).getJobs(['delayed', 'waiting'])).map((j) => j.data as { threadId: string; authorId: string; seq: number });
const turns = async (threadId = CONV) =>
  sql<{ authorId: string; status: string; messageTs: string[]; isMention: boolean }[]>`select author_id, status, message_ts, is_mention from turns where thread_id = ${threadId} order by id`;

async function makeCodeChannel(o: { parent?: boolean } = {}) {
  if (o.parent) await sql`insert into threads (id, channel_id, thread_ts) values (${PARENT}, 'C0PARENT', '1700000000.000001') on conflict do nothing`;
  await store.createCodeChannelRow({ channelId: C, sessionId: 'test-session', kind: 'task', name: 'x', parentThreadId: o.parent ? PARENT : null, requesterId: 'U1' });
}

describe.skipIf(!infra)('code channels (intake)', () => {
  beforeEach(async () => {
    await resetTestState();
    store.invalidateCodeChannelCache();
    await setCodeChannelsDisabled(false);
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

  it('a top-level message joins the :0 conversation, is gated with the code-channel note, and the turn runs with top-level status', async () => {
    await makeCodeChannel();
    const ts = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U1', text: 'can you look at the login bug', ts }));
    const [row] = await sql`select thread_id from messages where channel_id = ${C} and ts = ${ts}`;
    expect(row!.threadId).toBe(CONV);
    expect((await sql`select engaged from threads where id = ${CONV}`)[0]!.engaged).toBe(true);

    const gate = vi.spyOn(gateImpl, 'run').mockResolvedValue({ respond: true, raw: '0.9', latencyMs: 1, model: 'test', probability: 0.9 });
    try {
      const [dj] = await debounceJobs();
      expect(dj).toMatchObject({ threadId: CONV, authorId: 'U1' });
      await processDebounce(job(dj!));
      expect(gate).toHaveBeenCalledOnce();
      expect(gate.mock.calls[0]![0].note).toContain('dedicated session channel');
    } finally {
      gate.mockRestore();
    }
    expect(await turns()).toEqual([expect.objectContaining({ authorId: 'U1', status: 'pending', messageTs: [ts] })]);
    await processThreadRun(job({ threadId: CONV }));
    expect(run).toHaveBeenCalledOnce();
    const status = (await fakeCalls()).filter((c) => c.method === 'agents.sessions.setStatus').map((c) => c.args);
    expect(status.map((a) => a.status)).toEqual(['processing', 'active']);
    for (const a of status) expect(a).not.toHaveProperty('thread_ts');

    // Many unaddressed messages never disengage the conversation.
    for (let i = 0; i < 30; i++) await processSlackEvent(messageEnvelope({ user: 'U2', text: `side note ${i}`, ts: nextTs() }));
    expect((await sql`select engaged, messages_since_addressed from threads where id = ${CONV}`)[0]).toMatchObject({ engaged: true, messagesSinceAddressed: 0 });
  });

  it('a mention skips the gate', async () => {
    await makeCodeChannel();
    const ts = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> do it', ts }));
    expect(await takeBatch(CONV, 'U1')).toEqual([{ ts, reason: 'mention' }]);
  });

  it('thread replies are ignored until the bot is mentioned in that thread, then follow the ordinary thread rules', async () => {
    await makeCodeChannel();
    const root = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U1', text: 'top', ts: root }));
    const reply = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U2', text: 'unrelated reply', ts: reply, thread_ts: root }));
    expect(await sql`select ts from messages where ts = ${reply}`).toHaveLength(0);
    expect(await sql`select id from threads where id = ${`${C}:${root}`}`).toHaveLength(0);

    const ping = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U2', text: '<@UBOT> what do you think?', ts: ping, thread_ts: root }));
    expect(await takeBatch(`${C}:${root}`, 'U2')).toEqual([{ ts: ping, reason: 'mention' }]);
    const follow = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U2', text: 'and also this?', ts: follow, thread_ts: root }));
    expect(await takeBatch(`${C}:${root}`, 'U2')).toEqual([{ ts: follow, reason: 'gate' }]);
  });

  it('a marked parent-agent post starts a turn for the requester; other bot posts and mismatched markers are ignored', async () => {
    await makeCodeChannel({ parent: true });
    const plain = nextTs();
    await processSlackEvent(messageEnvelope({ bot_id: 'BOTHER', subtype: 'bot_message', text: 'some other bot', ts: plain }));
    const forged = nextTs();
    await processSlackEvent(messageEnvelope({ bot_id: 'BOTHER', subtype: 'bot_message', text: 'forged', ts: forged, metadata: parentMessageMetadata({ parentThreadId: PARENT, requesterId: 'U1' }) }));
    const wrong = nextTs();
    await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', text: 'wrong parent', ts: wrong, metadata: parentMessageMetadata({ parentThreadId: 'C9:1.1', requesterId: 'U1' }) }));
    expect(await debounceJobs()).toEqual([]);

    const ts = nextTs();
    await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', username: 'smasnug ai · from parent', text: 'please also add tests', ts, metadata: parentMessageMetadata({ parentThreadId: PARENT, requesterId: 'U1' }) }));
    expect(await takeBatch(CONV, 'U1')).toEqual([{ ts, reason: 'parent' }]);
    expect((await sql`select type, actor from thread_events where thread_id = ${CONV} and type = 'parent_message'`)[0]).toMatchObject({ actor: 'U1' });
  });

  it('a parent post the bot just made starts its turn directly; the echo (with or without metadata) adds nothing', async () => {
    await makeCodeChannel({ parent: true });
    const ts = nextTs();
    const marker = { parentThreadId: PARENT, requesterId: 'U1' };
    expect(await acceptOwnParentPost(C, { ts, text: 'please also add tests', bot_id: 'BBOT', user: 'UBOT', username: 'smasnug ai · from parent' }, marker)).toBe(true);
    expect(await debounceJobs()).toEqual([expect.objectContaining({ threadId: CONV, authorId: 'U1' })]);
    // Slack's echo: with the marker (deduped) and without it (an ordinary bot post).
    await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', username: 'smasnug ai · from parent', text: 'please also add tests', ts, metadata: parentMessageMetadata(marker) }));
    await processSlackEvent(messageEnvelope({ bot_id: 'BBOT', user: 'UBOT', username: 'smasnug ai · from parent', text: 'please also add tests', ts }));
    expect(await debounceJobs()).toHaveLength(1);
    expect(await takeBatch(CONV, 'U1')).toEqual([{ ts, reason: 'parent' }]);
    expect(await sql`select 1 from thread_events where thread_id = ${CONV} and type = 'parent_message'`).toHaveLength(1);
    expect((await sql`select thread_id, username from messages where channel_id = ${C} and ts = ${ts}`)[0]).toMatchObject({ threadId: CONV, username: 'smasnug ai · from parent' });
    // A marker for another parent thread is refused.
    expect(await acceptOwnParentPost(C, { ts: nextTs(), text: 'x', bot_id: 'BBOT' }, { parentThreadId: 'C9:1.1', requesterId: 'U1' })).toBe(false);
  });

  it('adopts a Slack-created agent channel on a mention; ordinary channels are left alone', async () => {
    await sql`insert into threads (id, channel_id, thread_ts) values (${PARENT}, 'C0PARENT', '1700000000.000001')`;
    const rm = addFakeHandler((method, args) => {
      if (method !== 'conversations.info') return undefined;
      if (args.channel === 'C0ADOPT')
        return { ok: true, channel: { id: 'C0ADOPT', name: 'agent-thing', is_private: false, is_member: true, properties: { record_channel: { record_type: 'agent_channel' }, agent_session: { encoded_agent_bot_user_ids: ['UBOT'], origin_link: { channel_id: 'C0PARENT', ts: '1700000000.000001' } } } } };
      if (args.channel === 'C0OTHER')
        return { ok: true, channel: { id: 'C0OTHER', name: 'their-agent', is_private: false, is_member: true, properties: { record_channel: { record_type: 'agent_channel' }, agent_session: { encoded_agent_bot_user_ids: ['UOTHERBOT'] } } } };
      if (args.channel === 'C0PLAIN') return { ok: true, channel: { id: 'C0PLAIN', name: 'plain', is_private: false, is_member: true } };
      return undefined;
    });
    try {
      const ts = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hi', ts }, 'C0ADOPT'));
      expect(await store.getCodeChannel('C0ADOPT')).toMatchObject({ kind: 'adopted', parentThreadId: PARENT, originChannelId: 'C0PARENT', originTs: '1700000000.000001', requesterId: 'U1' });
      expect(await takeBatch('C0ADOPT:0', 'U1')).toEqual([{ ts, reason: 'mention' }]);
      // Its slash commands are registered on adoption.
      const cmds = (await fakeCalls()).filter((c) => c.method === 'agents.conversations.setCommands');
      expect(cmds.map((c) => c.args)).toEqual([{ channel_id: 'C0ADOPT', commands: [expect.objectContaining({ name: 'archive' }), expect.objectContaining({ name: 'rename', argument_hint: '<new title>' })] }]);

      // Another app's agent channel is an ordinary channel to us.
      const other = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hi', ts: other }, 'C0OTHER'));
      expect(await store.getCodeChannel('C0OTHER')).toBeNull();
      expect(await takeBatch(`C0OTHER:${other}`, 'U1')).toEqual([{ ts: other, reason: 'mention' }]);

      const plain = nextTs();
      await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hi', ts: plain }, 'C0PLAIN'));
      expect(await store.getCodeChannel('C0PLAIN')).toBeNull();
      expect(await takeBatch(`C0PLAIN:${plain}`, 'U1')).toEqual([{ ts: plain, reason: 'mention' }]);
    } finally {
      rm();
    }
  });

  it('a message in a channel marked archived reopens it', async () => {
    await makeCodeChannel();
    await store.markCodeChannelArchived(C);
    await processSlackEvent(messageEnvelope({ user: 'U1', text: 'back again', ts: nextTs() }));
    expect((await store.getCodeChannel(C))!.archivedAt).toBeNull();
    expect((await sql`select type from thread_events where thread_id = ${CONV}`).map((e) => e.type)).toContain('code_channel_reopened');
  });

  it('is inert when the kill switch is off', async () => {
    await makeCodeChannel();
    await setCodeChannelsDisabled(true);
    const ts = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U1', text: 'hello?', ts }));
    expect(await sql`select ts from messages where ts = ${ts}`).toHaveLength(0);
    expect(await debounceJobs()).toEqual([]);
  });

  it('agent_session_stopped without thread_ts stops the :0 conversation and posts top level', async () => {
    await makeCodeChannel();
    await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'agent_session_stopped', channel: C, user: 'U1', event_ts: nextTs() } } }));
    expect(Number(await redis.get(stopKey(CONV)))).toBeGreaterThan(Date.now() - 5000);
    const calls = await fakeCalls();
    expect(calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args)).toEqual([{ channel: C, text: 'Stopped.' }]);
    // Native stop in a code channel: no further agents.* calls.
    expect(calls.filter((c) => c.method.startsWith('agents.'))).toEqual([]);
  });

  it('message_stream_stopped is an alias of agent_session_stopped, and the pair Slack sends during the rename counts once', async () => {
    await makeCodeChannel();
    const ev = { channel: C, user: 'U1', event_ts: nextTs(), streaming_message_ts: ['1700000000.000050'] };
    await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'message_stream_stopped', ...ev } } }));
    await processSlackEvent(job({ kind: 'event' as const, body: { event: { type: 'agent_session_stopped', ...ev } } }));
    expect(Number(await redis.get(stopKey(CONV)))).toBeGreaterThan(Date.now() - 5000);
    expect((await fakeCalls()).filter((c) => c.method === 'chat.postMessage').map((c) => c.args)).toEqual([{ channel: C, text: 'Stopped.' }]);
    expect(await sql`select 1 from thread_events where thread_id = ${CONV} and type = 'session_stopped'`).toHaveLength(1);
  });
});
