/**
 * LIVE=1: the front agent leaves a thread (leave_thread) when told to go away, and stays when it isn't.
 *   LIVE=1 INTEGRATION=1 pnpm vitest run src/agent/leave-thread.live.test.ts
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

describe.skipIf(!LIVE)('leave_thread (LIVE)', () => {
  let sql: typeof import('../db/index.js').sql;
  const user = `U_LEAVE${Date.now().toString(36).toUpperCase()}`;
  const io = { drainInbox: async () => [], setPhase: async () => {}, isMention: false };

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    await import('./register.js');
    await import('../tools/index.js');
    await import('../features/register.js');
  });
  afterAll(async () => {
    const { redis } = await import('../core/redis.js');
    await redis.quit();
    await sql.end();
  });

  async function turnIn(text: string, history: string) {
    const { runFrontTurn } = await import('./front.js');
    const ts = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const threadId = `C_LEAVE:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${threadId}, 'C_LEAVE', ${ts}, true)`;
    threadText.set(threadId, { history, newMessages: `[${ts}] <@${user}> Tester: ${text}` });
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${threadId}, ${user}, false, ${[ts]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io);
    const [th] = await sql<{ engaged: boolean }[]>`select engaged from threads where id = ${threadId}`;
    return th!.engaged;
  }

  const history = `<@${user}> Tester: <@UBOT> what's a good first microcontroller?\n[bot] Smasnug (you): honestly a pico 2 w, cheap and wireless.`;

  it('leaves when told to go away', async () => {
    expect(await turnIn('ok thanks bot, you can go away now, we got it from here', history)).toBe(false);
  }, 60_000);

  it('stays for a normal follow-up', async () => {
    expect(await turnIn('nice, does the pico 2 w do bluetooth too?', history)).toBe(true);
  }, 60_000);
});
