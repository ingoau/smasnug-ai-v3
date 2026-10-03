/**
 * Quick-reply button presses end to end through the interaction dispatcher (test Postgres/Redis, SLACK_FAKE=1).
 * Run: INTEGRATION=1 pnpm vitest run src/pipeline/reply-choice.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../agent/front.js', () => ({ runFrontTurn: vi.fn() }));

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const job = <D>(data: D) => ({ data, id: 'test' }) as unknown as Job<D>;

describe.skipIf(!INTEGRATION)('reply buttons: press flow', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  let store: typeof import('../agent/reply-buttons-store.js');
  let processSlackEvent: typeof import('./slack-events.js').processSlackEvent;
  let queues: typeof import('../core/queues.js');

  const C = `CBTN${rand()}`;
  const T = '1700000000.000100';
  const threadId = `${C}:${T}`;
  let n = 0;
  const botTs = () => `1700000100.${String(++n).padStart(6, '0')}`;

  async function offer(labels: string[], text = 'which board?') {
    const ts = botTs();
    await sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, text) values (${C}, ${ts}, ${threadId}, 'UBOT', 'BBOT', ${text})`;
    const row = await store.createReplyButtons({ threadId, channelId: C, turnId: n, key: `test:${threadId}:${n}`, labels });
    await store.setButtonsMessage(row.id, ts, text);
    return { id: row.id, ts };
  }
  const press = (o: { user: string; id: number; index: number; ts: string; actionTs: string }) =>
    processSlackEvent(
      job({
        kind: 'interactive' as const,
        body: {
          type: 'block_actions',
          user: { id: o.user },
          channel: { id: C },
          container: { channel_id: C, message_ts: o.ts, thread_ts: T },
          message: { ts: o.ts, thread_ts: T },
          actions: [{ action_id: `reply:choice:${o.index}`, value: String(o.id), action_ts: o.actionTs }],
        },
      }),
    );
  const turnsOf = () => sql<{ authorId: string; status: string; messageTs: string[]; isMention: boolean }[]>`
    select author_id, status, message_ts, is_mention from turns where thread_id = ${threadId} order by id`;
  const callsSince = async (k: number) => (await fakeCalls()).slice(k);

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    store = await import('../agent/reply-buttons-store.js');
    ({ processSlackEvent } = await import('./slack-events.js'));
    queues = await import('../core/queues.js');
    await import('./register.js'); // registers reply:choice
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${threadId}, ${C}, ${T}, false) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    await sql`delete from threads where id = ${threadId}`;
    await sql`delete from user_blocks where user_id like 'UBTN%'`;
    await queues.closeQueues();
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  it('first press: note replaces the buttons, synthetic message stored, mention turn for the presser; later presses ignored', async () => {
    const { id, ts } = await offer(['ESP32', 'Pico']);
    const k = (await fakeCalls()).length;
    await press({ user: 'UBTNA', id, index: 1, ts, actionTs: '1700000200.123456' });

    const [row] = await sql<any[]>`select * from reply_buttons where id = ${id}`;
    expect(row).toMatchObject({ pressedBy: 'UBTNA', pressedLabel: 'Pico', pressedMessageTs: '1700000200.123456' });

    const upd = (await callsSince(k)).find((c) => c.method === 'chat.update' && c.args.ts === ts)!;
    expect(upd).toBeTruthy();
    expect(upd.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'context']);
    expect(upd.args.blocks[0].text).toBe('which board?');
    expect(upd.args.blocks[1].elements[0].text).toBe('<@UBTNA> pressed *Pico*');
    expect(JSON.stringify(upd.args.blocks)).not.toContain('reply:choice');

    const [msg] = await sql<any[]>`select * from messages where channel_id = ${C} and ts = '1700000200.123456'`;
    expect(msg).toMatchObject({ userId: 'UBTNA', text: 'Pico', threadId, botId: null });
    const [ev] = await sql<any[]>`select actor, payload from thread_events where thread_id = ${threadId} and type = 'message' order by id desc limit 1`;
    expect(ev).toMatchObject({ actor: 'UBTNA', payload: { ts: '1700000200.123456', button: { id, label: 'Pico' } } });
    const [th] = await sql<any[]>`select engaged, messages_since_addressed from threads where id = ${threadId}`;
    expect(th).toMatchObject({ engaged: true, messagesSinceAddressed: 0 });
    expect(await turnsOf()).toEqual([{ authorId: 'UBTNA', status: 'pending', messageTs: ['1700000200.123456'], isMention: true }]);
    const jobs = (await queues.queue(queues.QUEUE.threadRun).getJobs(['waiting', 'delayed', 'prioritized'])).map((j) => j.data);
    expect(jobs).toContainEqual({ threadId });

    // A second press (someone else, or a double click) changes nothing; the presser gets an ephemeral.
    const k2 = (await fakeCalls()).length;
    await press({ user: 'UBTNB', id, index: 0, ts, actionTs: '1700000201.000001' });
    const after = await callsSince(k2);
    expect(after.filter((c) => c.method === 'chat.update')).toHaveLength(0);
    expect(after.find((c) => c.method === 'chat.postEphemeral')?.args).toMatchObject({ user: 'UBTNB', channel: C, thread_ts: T });
    const [row2] = await sql<any[]>`select pressed_by, pressed_label from reply_buttons where id = ${id}`;
    expect(row2).toMatchObject({ pressedBy: 'UBTNA', pressedLabel: 'Pico' });
    expect(await sql`select 1 from messages where channel_id = ${C} and ts = '1700000201.000001'`).toHaveLength(0);
    expect(await turnsOf()).toHaveLength(1);
  });

  it('the context shows the offered buttons, who pressed what, and the press as a (button) message', async () => {
    const { renderThreadContext } = await import('../context/thread.js');
    const ctx = await renderThreadContext(threadId, { newMessageTs: ['1700000200.123456'] });
    expect(ctx.history).toMatch(/which board\? \[buttons: ESP32 \| Pico; .+ pressed "Pico"\]/);
    expect(ctx.newMessages).toMatch(/^\[1700000200\.123456\] <@UBTNA> .*: Pico \(button\)$/);
  });

  it('a suspended user gets nothing and the buttons stay pressable', async () => {
    const { setBlock } = await import('../features/state.js');
    await setBlock('UBTNX', { suspended: true, reason: 'test' });
    const { id, ts } = await offer(['Yes', 'No'], 'want more?');
    const k = (await fakeCalls()).length;
    await press({ user: 'UBTNX', id, index: 0, ts, actionTs: '1700000300.000001' });
    expect((await callsSince(k)).filter((c) => c.method === 'chat.update')).toHaveLength(0);
    const [row] = await sql<any[]>`select pressed_at from reply_buttons where id = ${id}`;
    expect(row.pressedAt).toBeNull();
    expect((await turnsOf()).filter((t) => t.authorId === 'UBTNX')).toHaveLength(0);
  });

  it('a plan card living in the pressed reply is re-rendered with the note (plan kept)', async () => {
    const { id, ts } = await offer(['Go deeper', 'All good'], 'here is the gist. want more?');
    await sql`insert into cards (thread_id, channel_id, message_ts, reply_text) values (${threadId}, ${C}, ${ts}, 'here is the gist. want more?')`;
    const k = (await fakeCalls()).length;
    await press({ user: 'UBTNC', id, index: 0, ts, actionTs: '1700000400.000001' });
    const upd = (await callsSince(k)).find((c) => c.method === 'chat.update' && c.args.ts === ts)!;
    expect(upd.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'context', 'plan']);
    expect(upd.args.blocks[1].elements[0].text).toBe('<@UBTNC> pressed *Go deeper*');
    expect(upd.args.text).toBe('here is the gist. want more?');
  });
});
