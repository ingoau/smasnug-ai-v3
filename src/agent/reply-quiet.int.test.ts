/**
 * No-turn quick-reply buttons (reply-quiet.ts) end to end through the interaction dispatcher (test Postgres/Redis,
 * SLACK_FAKE=1). Run: INTEGRATION=1 pnpm vitest run src/agent/reply-quiet.int.test.ts
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
vi.mock('./front.js', () => ({ runFrontTurn: vi.fn() }));

const ran: { speaker: string; key: string; say: string }[] = [];
const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const job = <D>(data: D) => ({ data, id: 'test' }) as unknown as Job<D>;

describe.skipIf(!INTEGRATION)('reply buttons: no-turn presses', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  let store: typeof import('./reply-buttons-store.js');
  let buttons: typeof import('./reply-buttons.js');
  let processSlackEvent: typeof import('../pipeline/slack-events.js').processSlackEvent;
  let queues: typeof import('../core/queues.js');

  const C = `CQBT${rand()}`;
  const T = '1700000000.000100';
  const threadId = `${C}:${T}`;
  let n = 0;
  const botTs = () => `1700000100.${String(++n).padStart(6, '0')}`;

  async function offer(raw: unknown[], text = 'want me to draft it?', requesterId?: string) {
    const ts = botTs();
    await sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, text) values (${C}, ${ts}, ${threadId}, 'UBOT', 'BBOT', ${text})`;
    const { labels, responses } = buttons.normalizeButtons(raw);
    const row = await store.createReplyButtons({ threadId, channelId: C, turnId: n, key: `test:${threadId}:${n}`, labels, responses, requesterId: requesterId ?? null });
    await store.setButtonsMessage(row.id, ts, text);
    return { id: row.id, ts, row };
  }
  const press = (o: { user: string; id: number; actionId: string; ts: string; actionTs: string }) =>
    processSlackEvent(
      job({
        kind: 'interactive' as const,
        body: {
          type: 'block_actions',
          user: { id: o.user },
          channel: { id: C },
          container: { channel_id: C, message_ts: o.ts, thread_ts: T },
          message: { ts: o.ts, thread_ts: T },
          actions: [{ action_id: o.actionId, value: String(o.id), action_ts: o.actionTs }],
        },
      }),
    );
  const turnsOf = () => sql<{ authorId: string }[]>`select author_id from turns where thread_id = ${threadId} order by id`;
  const callsSince = async (k: number) => (await fakeCalls()).slice(k);

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    store = await import('./reply-buttons-store.js');
    buttons = await import('./reply-buttons.js');
    ({ processSlackEvent } = await import('../pipeline/slack-events.js'));
    queues = await import('../core/queues.js');
    await import('../pipeline/register.js'); // reply:choice
    await import('./register.js'); // reply:quiet
    const { registerButtonAction } = await import('./button-actions.js');
    const { z } = await import('zod');
    registerButtonAction({
      name: 'test_echo',
      args: z.object({ say: z.string() }),
      check: async (_ctx, a) => (a.say === 'blocked' ? 'that one is blocked' : null),
      run: async (ctx, a) => {
        ran.push({ speaker: ctx.speakerId, key: ctx.key, say: a.say });
        return a.say === 'fail' ? { ok: false, text: 'it broke' } : { ok: true, text: `said ${a.say}` };
      },
    });
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${threadId}, ${C}, ${T}, false) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    await sql`delete from threads where id = ${threadId}`;
    await queues.closeQueues();
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  it('stores responses, renders no-turn buttons as reply:quiet, and a fixed reply is posted once with no turn', async () => {
    const { id, ts, row } = await offer(['Yes, draft it', { label: 'No thanks', fixed_reply: 'all good 👍' }, { label: 'Later', no_turn: true }]);
    expect(row.responses).toEqual([null, { kind: 'text', text: 'all good 👍' }, { kind: 'none' }]);
    expect(buttons.buttonsActions(store.toButtonsState(row)).elements.map((e) => e.action_id)).toEqual(['reply:choice:0', 'reply:quiet:1', 'reply:quiet:2']);

    const k = (await fakeCalls()).length;
    await press({ user: 'UQBTA', id, actionId: 'reply:quiet:1', ts, actionTs: '1700000200.000001' });
    const after = await callsSince(k);
    const upd = after.find((c) => c.method === 'chat.update' && c.args.ts === ts)!;
    expect(upd.args.blocks.at(-1).elements[0].text).toBe('<@UQBTA> pressed *No thanks*');
    expect(after.filter((c) => c.method === 'chat.postMessage').map((c) => c.args.text)).toEqual(['all good 👍']);
    const [msg] = await sql<any[]>`select user_id, text from messages where channel_id = ${C} and ts = '1700000200.000001'`;
    expect(msg).toMatchObject({ userId: 'UQBTA', text: 'No thanks' });
    expect(await turnsOf()).toHaveLength(0);
    const [th] = await sql<any[]>`select engaged from threads where id = ${threadId}`;
    expect(th.engaged).toBe(false);

    // A second press: ephemeral only.
    const k2 = (await fakeCalls()).length;
    await press({ user: 'UQBTB', id, actionId: 'reply:quiet:2', ts, actionTs: '1700000201.000001' });
    const later = await callsSince(k2);
    expect(later.map((c) => c.method)).toEqual(['chat.postEphemeral']);
  });

  it('no_turn without text only marks the press; a row without responses falls back to a normal (turn) press', async () => {
    const a = await offer([{ label: 'Never mind', no_turn: true }, 'Go']);
    const k = (await fakeCalls()).length;
    await press({ user: 'UQBTC', id: a.id, actionId: 'reply:quiet:0', ts: a.ts, actionTs: '1700000300.000001' });
    const after = await callsSince(k);
    expect(after.some((c) => c.method === 'chat.update')).toBe(true);
    expect(after.filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
    expect(await turnsOf()).toHaveLength(0);

    const b = await offer(['Yes', 'No']);
    expect(b.row.responses).toBeNull();
    await press({ user: 'UQBTD', id: b.id, actionId: 'reply:quiet:1', ts: b.ts, actionTs: '1700000301.000001' });
    expect((await turnsOf()).map((t) => t.authorId)).toEqual(['UQBTD']);
  });

  it('a text button with place append adds its text to the reply instead of posting', async () => {
    const { id, ts } = await offer([{ label: 'All good', type: 'text', text: 'great 👍', place: 'append' }], 'did that work?');
    const k = (await fakeCalls()).length;
    await press({ user: 'UQBTE', id, actionId: 'reply:quiet:0', ts, actionTs: '1700000400.000001' });
    const after = await callsSince(k);
    expect(after.filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
    const upd = after.find((c) => c.method === 'chat.update' && c.args.ts === ts)!;
    expect(upd.args.text).toContain('did that work?');
    expect(upd.args.text).toContain('great 👍');
    expect((await store.loadReplyButtons(id))!.replyText).toBe('did that work?\n\ngreat 👍');
  });

  it('an action button runs its call as the presser, only for the requester, and appends done_text', async () => {
    const { id, ts, row } = await offer([{ label: 'Say it', type: 'action', action: { tool: 'test_echo', args: { say: 'hi' } }, done_text: 'said it ✓' }], 'here it is', 'UQBTR');
    expect(row.responses).toEqual([{ kind: 'action', tool: 'test_echo', args: '{"say":"hi"}', done: 'said it ✓' }]);
    expect(row.requesterId).toBe('UQBTR');

    // Someone else: refused privately, nothing claimed.
    const k0 = (await fakeCalls()).length;
    await press({ user: 'UQBTX', id, actionId: 'reply:quiet:0', ts, actionTs: '1700000500.000001' });
    expect((await callsSince(k0)).map((c) => [c.method, c.args.text])).toEqual([['chat.postEphemeral', 'Only <@UQBTR> can press that one.']]);
    expect((await store.loadReplyButtons(id))!.pressedAt).toBeNull();

    const turnsBefore = (await turnsOf()).length;
    const k = (await fakeCalls()).length;
    await press({ user: 'UQBTR', id, actionId: 'reply:quiet:0', ts, actionTs: '1700000501.000001' });
    expect(ran.at(-1)).toEqual({ speaker: 'UQBTR', key: String(id), say: 'hi' });
    const after = await callsSince(k);
    expect(after.filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
    const last = after.filter((c) => c.method === 'chat.update' && c.args.ts === ts).at(-1)!;
    expect(last.args.text).toContain('here it is');
    expect(last.args.text).toContain('said it ✓');
    expect(last.args.blocks.at(-1).elements[0].text).toBe('<@UQBTR> pressed *Say it* · done ✓');
    const saved = (await store.loadReplyButtons(id))!;
    expect(saved.outcome).toEqual({ ok: true, text: 'said hi' });
    expect(await turnsOf()).toHaveLength(turnsBefore);
  });

  it('a failed action shows it and starts an outcome turn for the presser', async () => {
    const { id, ts } = await offer([{ label: 'Break it', type: 'action', action: { tool: 'test_echo', args: { say: 'fail' } }, who: 'anyone' }], 'try this', 'UQBTR');
    await press({ user: 'UQBTF', id, actionId: 'reply:quiet:0', ts, actionTs: '1700000600.000001' });
    expect((await store.loadReplyButtons(id))!.outcome).toEqual({ ok: false, text: 'it broke' });
    const [inp] = await sql<any[]>`select source, source_ref, input, fallback from scheduled_turn_inputs where source = 'button_action' and source_ref = ${`buttons:${id}`}`;
    expect(inp.input).toContain('it broke');
    expect(inp.input).toContain('test_echo');
    const turns = await sql<any[]>`select author_id, kind from turns where thread_id = ${threadId} order by id`;
    expect(turns.at(-1)).toMatchObject({ authorId: 'UQBTF', kind: 'scheduled' });
  });

  it('a prompt button with place append makes the turn\'s first reply go into that message', async () => {
    const { id, ts } = await offer([{ label: 'Bigger', place: 'append' }, 'Other'], 'here you go');
    await press({ user: 'UQBTG', id, actionId: 'reply:choice:0', ts, actionTs: '1700000700.000001' });
    expect(await store.placeTargetFor(threadId, ['1700000700.000001'])).toEqual({ ts, buttonsId: id, place: 'append' });
    expect(await store.placeTargetFor(threadId, ['1700000799.000001'])).toBeNull();
  });
});
