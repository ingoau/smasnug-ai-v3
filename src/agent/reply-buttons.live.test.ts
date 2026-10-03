/**
 * LIVE=1: the real front agent (OpenRouter), SLACK_FAKE Slack, test Postgres/Redis. Using buttons on an ambiguous
 * request is the model's choice, so that case only asserts that WHEN it offers buttons they are within limits and
 * actually rendered under the reply (whether it did is logged); a speaker explicitly asking for buttons must get them.
 *   LIVE=1 pnpm vitest run src/agent/reply-buttons.live.test.ts
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

describe.skipIf(!LIVE)('reply buttons (LIVE front agent)', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  const user = `U_BTN${Date.now().toString(36).toUpperCase()}`;
  const channel = 'D_BTN_TEST';

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    await import('./register.js');
    await import('../tools/index.js');
    await import('../features/register.js');
  });

  afterAll(async () => {
    if (!LIVE) return;
    const { closeQueues } = await import('../core/queues.js');
    await closeQueues();
    await redis.quit();
    await sql.end();
  });

  /** One real front turn in a fresh DM thread; returns the reply_buttons rows and the thread's Slack calls. */
  async function turnFor(text: string) {
    const { runFrontTurn } = await import('./front.js');
    const rootTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const threadId = `${channel}:${rootTs}`;
    await sql`insert into threads (id, channel_id, thread_ts, is_dm, engaged) values (${threadId}, ${channel}, ${rootTs}, true, true) on conflict do nothing`;
    threadText.set(threadId, { history: '', newMessages: `[${rootTs}] <@${user}> Tester: ${text}` });
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, kind, is_mention, message_ts, status) values (${threadId}, ${user}, 'user', true, ${[rootTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id), cardId: null }, { drainInbox: async () => [], setPhase: async () => {}, isMention: true });
    const rows = await sql<{ labels: string[]; messageTs: string | null }[]>`select labels, message_ts from reply_buttons where thread_id = ${threadId} order by id`;
    const replyTs = new Set(rows.map((r) => r.messageTs));
    const calls = (await fakeCalls()).filter((c) => c.args?.channel === channel && (c.args.thread_ts === rootTs || replyTs.has(c.args.ts)));
    console.info(`[reply-buttons live] "${text}" → buttons: ${rows.length ? rows.map((r) => r.labels.join(' | ')).join(' / ') : 'none'}`);
    return { rows, calls };
  }

  it('buttons are offered for a clear choice; any buttons are ≤5 short labels rendered under the reply', async () => {
    const [ambiguous, explicit] = await Promise.all([
      // Whether the model offers buttons here is its call (it often asks an open "what are you building?").
      turnFor('can you help me pick a microcontroller?'),
      turnFor('give me a quick yes/no question with buttons: do i want wifi on my board?'),
    ]);
    await expectWithinLimits(ambiguous);
    await expectWithinLimits(explicit);
    expect(explicit.rows.length).toBeGreaterThan(0);
  }, 90_000);

  async function expectWithinLimits({ rows, calls }: Awaited<ReturnType<typeof turnFor>>) {
    const { MAX_BUTTONS, MAX_LABEL_CHARS, SLACK_BUTTON_TEXT_MAX } = await import('./reply-buttons.js');
    expect(calls.some((c) => ['chat.postMessage', 'chat.startStream'].includes(c.method))).toBe(true);
    for (const r of rows) {
      expect(r.labels.length).toBeGreaterThan(0);
      expect(r.labels.length).toBeLessThanOrEqual(MAX_BUTTONS);
      for (const l of r.labels) {
        expect([...l].length).toBeLessThanOrEqual(SLACK_BUTTON_TEXT_MAX);
        // eslint-disable-next-line no-console
        if ([...l].length > MAX_LABEL_CHARS) console.log(`label over the suggested ${MAX_LABEL_CHARS} chars (shown as written):`, l);
      }
      expect(r.messageTs).toBeTruthy();
      // Rendered: an actions block with exactly these labels went out (post, stopStream blocks, or update).
      const rendered = calls.some((c) =>
        (c.args.blocks ?? []).some((b: any) => b.type === 'actions' && JSON.stringify(b.elements.map((e: any) => e.text.text)) === JSON.stringify(r.labels)),
      );
      expect(rendered).toBe(true);
    }
  }
});
