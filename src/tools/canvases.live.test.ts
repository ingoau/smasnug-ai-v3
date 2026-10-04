/**
 * LIVE=1: the real front agent (model API), SLACK_FAKE Slack, test Postgres/Redis. Checks that a long deliverable
 * becomes a canvas whose link is in the reply, that a linked canvas is read with read_canvas, that the bot edits its
 * own canvas when asked, and that a short question doesn't produce a canvas.
 *   LIVE=1 pnpm vitest run src/tools/canvases.live.test.ts
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

const threadText = new Map<string, { history: string; newMessages: string }>();
vi.mock('../context/thread.js', () => ({
  renderThreadContext: async (threadId: string) => ({ history: threadText.get(threadId)?.history ?? '', channelContext: '', newMessages: threadText.get(threadId)?.newMessages ?? '' }),
  renderMessages: async () => '',
}));
vi.mock('../pipeline/scheduler.js', () => ({ requestTurn: async () => 0 }));

describe.skipIf(!LIVE)('canvases (LIVE front agent)', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  const user = `U_CNV${Date.now().toString(36).toUpperCase()}`;
  const channel = `D_CNV${Date.now().toString(36).toUpperCase()}`;
  const foreign = `FLIVE${Date.now().toString(36).toUpperCase()}`;
  const threads: string[] = [];
  let remove: (() => void) | undefined;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const fake = await import('../core/slack-fake.js');
    fakeCalls = fake.fakeCalls;
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    // A canvas someone shared in this DM, so read_canvas may open it.
    remove = fake.addFakeHandler((method, args) => {
      if (method === 'files.info' && args.file === foreign) return { ok: true, file: { id: foreign, title: 'Hackathon checklist', ims: [channel] } };
      if (method === 'canvases.getContent' && args.canvas_id === foreign)
        return { ok: true, content: '# Hackathon checklist\n- [x] venue booked\n- [ ] snacks\n- [ ] judges (need 3, have 1)\n' };
      return undefined;
    });
    await import('../agent/register.js');
    await import('./index.js');
    await import('../features/register.js');
  });

  afterAll(async () => {
    if (!LIVE) return;
    remove?.();
    for (const id of threads) await sql`delete from threads where id = ${id}`;
    await sql`delete from bot_canvases where channel_id = ${channel}`;
    const { closeQueues } = await import('../core/queues.js');
    await closeQueues();
    await redis.quit();
    await sql.end();
  });

  /** One real front turn in a DM thread; returns the thread's canvas and reply calls. */
  async function turn(text: string, opts: { rootTs?: string; history?: string } = {}) {
    const { runFrontTurn } = await import('../agent/front.js');
    const rootTs = opts.rootTs ?? `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const threadId = `${channel}:${rootTs}`;
    threads.push(threadId);
    await sql`insert into threads (id, channel_id, thread_ts, is_dm, engaged) values (${threadId}, ${channel}, ${rootTs}, true, true) on conflict do nothing`;
    const msgTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    threadText.set(threadId, { history: opts.history ?? '', newMessages: `[${msgTs}] <@${user}> Tester: ${text}` });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, kind, is_mention, message_ts, status) values (${threadId}, ${user}, 'user', true, ${[msgTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id), cardId: null }, { drainInbox: async () => [], setPhase: async () => {}, isMention: true });
    const calls = (await fakeCalls()).slice(before);
    const replies = calls
      .filter((c) => c.args?.channel === channel && ['chat.postMessage', 'chat.startStream', 'chat.appendStream'].includes(c.method))
      .map((c) => JSON.stringify(c.args))
      .join('\n');
    return { rootTs, calls, replies, canvasCalls: (m: string) => calls.filter((c) => c.method === m) };
  }

  it('a long deliverable becomes a canvas linked in the reply; the bot then edits it', async () => {
    const first = await turn(
      'can you write me a detailed 4-week study plan for learning rust from scratch, week by week with goals, resources and a mini project each week? put it in a canvas so i can keep it',
    );
    const created = first.canvasCalls('canvases.create');
    expect(created).toHaveLength(1);
    expect(String(created[0]!.args.document_content.markdown).length).toBeGreaterThan(500);
    const [row] = await sql<{ canvasId: string; permalink: string }[]>`select canvas_id, permalink from bot_canvases where channel_id = ${channel} order by created_at desc limit 1`;
    expect(first.replies).toContain(row!.canvasId);

    const second = await turn('nice, add a week 5 about async rust to the canvas', {
      rootTs: first.rootTs,
      history: `[bot] smasnug ai (you): here's the plan: ${row!.permalink}`,
    });
    expect(second.canvasCalls('canvases.create')).toHaveLength(0);
    expect(second.canvasCalls('canvases.edit').length).toBeGreaterThan(0);
  }, 180_000);

  it('a linked canvas is read before answering', async () => {
    const r = await turn(`what's still missing on this checklist? https://fake.slack.com/docs/TFAKE/${foreign}`);
    expect(r.canvasCalls('canvases.getContent').some((c) => c.args.canvas_id === foreign)).toBe(true);
    expect(r.replies.toLowerCase()).toMatch(/snack|judge/);
  }, 90_000);

  it('a short question gets no canvas', async () => {
    const r = await turn("what's the difference between a crate and a module in rust, quickly?");
    expect(r.canvasCalls('canvases.create')).toHaveLength(0);
  }, 90_000);
});
