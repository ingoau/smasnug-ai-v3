/**
 * Memory against real Postgres + Redis (model call mocked): extraction scheduling, relevance-based injection, tools.
 * Needs local infra: LIVE=1.
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
  generateText: async (opts: { instructions: string; prompt: string }) => {
    // Other test files' threads may be extracted in the same run: only this test's participant gets ops.
    if (!opts.instructions.includes('U_MEMX')) return { output: { ops: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    calls.push(opts.prompt);
    const second = opts.prompt.includes('prefer Rust');
    const fact = second ? 'prefers Rust over Python' : 'is building a robot arm';
    const evidence = second ? 'prefer Rust over Python' : 'building a robot arm';
    return {
      output: { ops: [{ op: 'add', user_id: 'U_MEMX', fact_id: null, text: fact, kind: second ? 'preference' : 'project', evidence }] },
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

describe.skipIf(!LIVE)('memory reading and tools (DB)', () => {
  let sql: typeof import('../../db/index.js').sql;
  let store: typeof import('./store.js');
  let render: typeof import('./render.js');
  let tools: typeof import('./tools.js');
  const user = 'U_MEMR';
  const channel = 'D_MEMR_TEST';
  const rootTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const threadId = `${channel}:${rootTs}`;
  const ctx = () => ({ role: 'front' as const, threadId, channelId: channel, threadTs: rootTs, speakerId: user, extras: {} });
  const run = (t: { execute?: unknown }, input: object) => (t.execute as (i: object, o: object) => Promise<string>)(input, { toolCallId: 't', messages: [] });

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    store = await import('./store.js');
    render = await import('./render.js');
    tools = await import('./tools.js');
    await sql`delete from user_memory where user_id = ${user}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${rootTs})`;
  });

  afterAll(async () => {
    await sql`delete from threads where id = ${threadId}`;
    await sql`delete from user_memory where user_id = ${user}`;
  });

  it('injects the facts relevant to the conversation even when they are old and others were used more recently', async () => {
    for (let i = 0; i < 30; i++) await store.addFact(user, `knows tool number ${i}`, null, 'about');
    const old = await store.addFact(user, 'is learning Haskell for a compilers course', null, 'project');
    const pref = await store.addFact(user, 'prefers short answers', null, 'preference');
    await sql`update user_memory set stated_at = now() - interval '200 days', last_used = now() - interval '100 days' where id = ${old.id}`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${rootTs}, ${threadId}, ${user}, 'how do monads work in haskell again?')`;

    const text = await render.renderSpeakerMemory(user, { threadId });
    expect(text).toContain(`[m_${old.id}] is learning Haskell for a compilers course (6 mo ago)`);
    expect(text).toContain(`[m_${pref.id}] prefers short answers`);
    expect(text).toMatch(/more not shown: search_memory/);
    const [row] = await sql<{ lastUsed: Date }[]>`select last_used from user_memory where id = ${old.id}`;
    expect(Date.now() - new Date(row!.lastUsed).getTime()).toBeLessThan(60_000);
  });

  it('remember refuses near-duplicates, replaces by id, and search_memory finds hidden facts', async () => {
    const remember = tools.rememberTool(ctx());
    expect(await run(remember, { fact: 'Prefers short answers.', kind: 'preference' })).toMatch(/^Already remembered as m_\d+/);
    const saved = await run(remember, { fact: 'uses Rust for embedded work', kind: 'about' });
    const id = /m_(\d+)/.exec(saved)![1];
    expect(await run(remember, { fact: 'uses Zig for embedded work now', kind: 'about', replaces: `m_${id}` })).toMatch(new RegExp(`^Updated m_${id} \\(was: "uses Rust`));
    // A near-duplicate without replaces updates the existing fact instead of adding a second one.
    const before = await store.countFacts(user);
    expect(await run(remember, { fact: 'is learning Haskell for a compilers course at uni', kind: 'project' })).toMatch(/^Updated m_\d+ \(was: "is learning Haskell/);
    expect(await store.countFacts(user)).toBe(before);
    expect(await run(remember, { fact: 'has ADHD', kind: 'about' })).toMatch(/^Not saved/);
    const search = tools.searchMemoryTool(ctx());
    expect(await run(search, { query: 'zig' })).toContain(`[m_${id}] uses Zig for embedded work now [about]`);
    expect(await run(search, { query: 'compilers' })).toContain('is learning Haskell for a compilers course at uni');
    await run(remember, { fact: 'uses Go at work', kind: 'about' });
    expect(await run(search, { query: 'go' })).toContain('uses Go at work');
    expect(await run(search, { query: 'kubernetes' })).toBe('No saved fact matches.');
  });
});
