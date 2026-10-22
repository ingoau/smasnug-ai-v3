/**
 * Memory extraction scheduling against real Postgres + Redis (model call mocked). Needs local infra: LIVE=1.
 *   LIVE=1 pnpm vitest run src/features/memory/extract.db.test.ts
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

const calls: string[] = [];
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: async (opts: { prompt: string }) => {
    calls.push(opts.prompt);
    const fact = calls.length === 1 ? 'is building a robot arm' : 'prefers Rust over Python';
    const evidence = calls.length === 1 ? 'building a robot arm' : 'prefer Rust over Python';
    return {
      output: { ops: [{ op: 'add', user_id: 'U_MEMX', fact_id: null, text: fact, evidence }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
}));
vi.mock('../guard.js', () => ({ recordModelUsage: async () => {} }));
vi.mock('../util.js', () => ({ userProfile: async (id: string) => ({ name: `name-${id}` }) }));

describe.skipIf(!LIVE)('memory extraction (DB)', () => {
  let sql: typeof import('../../db/index.js').sql;
  let extract: typeof import('./extract.js');
  const user = 'U_MEMX';
  const channel = 'D_MEMX_TEST';
  const rootTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const threadId = `${channel}:${rootTs}`;

  async function userSays(ts: string, text: string) {
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${ts}, ${threadId}, ${user}, ${text})`;
    await sql`insert into turns (thread_id, author_id, status, message_ts) values (${threadId}, ${user}, 'done', ${[ts]})`;
    // Idle long enough for the pass to pick it up.
    await sql`update threads set last_activity_at = now() - interval '2 hours' where id = ${threadId}`;
  }

  const facts = async () => (await sql<{ text: string }[]>`select text from user_memory where user_id = ${user} order by id`).map((f) => f.text);

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    extract = await import('./extract.js');
    await sql`delete from user_memory where user_id = ${user}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs})`;
  });

  afterAll(async () => {
    await sql`delete from threads where id = ${threadId}`;
    await sql`delete from user_memory where user_id = ${user}`;
  });

  it('extracts again when the conversation continues after an earlier pass', async () => {
    await userSays(`${rootTs}`, "hey, I'm building a robot arm for Blueprint");
    await extract.runMemoryExtraction();
    expect(await facts()).toEqual(['is building a robot arm']);

    // The thread continues later: the next pass must claim it again (memory_extracted_at has sub-ms precision).
    await userSays(`${Number(rootTs) + 1}.000000`, 'also I prefer Rust over Python these days');
    await extract.runMemoryExtraction();
    expect(calls).toHaveLength(2);
    expect(await facts()).toEqual(['is building a robot arm', 'prefers Rust over Python']);
  });
});
