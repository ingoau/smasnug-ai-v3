/**
 * Memory prune against real Postgres + Redis (model call mocked): picking users, claiming, applying + the audit copy.
 *   LIVE=1 pnpm vitest run src/features/memory/prune.db.test.ts
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

const user = 'U_MEMPRUNE';
const ids: Record<string, number> = {};
let calls = 0;
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: async (opts: { prompt: string }) => {
    if (opts.prompt.includes('stale-marker')) {
      // The user edits the fact while the model is thinking: the removal must not apply.
      const { sql } = await import('../../db/index.js');
      await sql`update user_memory set text = 'stale-marker edited meanwhile', stated_at = now() where id = ${ids.stale!}`;
      return {
        output: { ops: [{ op: 'remove', fact_id: ids.stale, merge_ids: null, text: null, reason: 'one-off' }, { op: 'remove', fact_id: ids.stale2, merge_ids: null, text: null, reason: 'one-off' }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    // Other users' facts (other test files) get no ops.
    if (!opts.prompt.includes('cheese-swapped')) return { output: { ops: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    calls++;
    return {
      output: {
        ops: [
          { op: 'remove', fact_id: ids.cheese, merge_ids: null, text: null, reason: 'one-off emoji request' },
          { op: 'merge', fact_id: ids.improve, merge_ids: [ids.faster], text: 'is making smasnug AI faster', reason: 'same project' },
          { op: 'remove', fact_id: ids.pref, merge_ids: null, text: null, reason: 'not useful' },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
}));
vi.mock('../guard.js', () => ({ recordModelUsage: async () => {} }));

describe.skipIf(!LIVE)('memory prune (DB)', () => {
  let sql: typeof import('../../db/index.js').sql;
  let prune: typeof import('./prune.js');

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    prune = await import('./prune.js');
    await sql`delete from user_memory where user_id = ${user}`;
    await sql`delete from memory_prune_state where user_id = ${user}`;
    await sql`delete from memory_pruned where user_id = ${user}`;
    const add = async (key: string, text: string, kind: string, statedAt: string) => {
      const [r] = await sql<{ id: string }[]>`
        insert into user_memory (user_id, text, kind, stated_at, created_at) values (${user}, ${text}, ${kind}, ${statedAt}, ${statedAt}) returning id`;
      ids[key] = Number(r!.id);
    };
    await add('improve', 'is making improvements to smasnug AI', 'project', '2026-10-01T00:00:00Z');
    await add('faster', 'is optimizing smasnug AI for faster initial responses', 'project', '2026-10-20T00:00:00Z');
    await add('cheese', 'is adding cheese-swapped caption emojis to the workspace', 'project', '2026-10-25T00:00:00Z');
    await add('pref', 'prefers short answers', 'preference', '2026-10-25T00:00:00Z');
    await add('rust', 'knows Rust', 'about', '2026-10-25T00:00:00Z');
  });

  afterAll(async () => {
    await sql`delete from user_memory where user_id = ${user}`;
    await sql`delete from memory_prune_state where user_id = ${user}`;
    await sql`delete from memory_pruned where user_id = ${user}`;
  });

  it('prunes once, keeps an audit copy, and does not run again the same day', async () => {
    await prune.runMemoryPrune();
    expect(calls).toBe(1);
    const left = await sql<{ id: string; text: string; kind: string; statedAt: Date }[]>`
      select id, text, kind, stated_at from user_memory where user_id = ${user} order by id`;
    expect(left.map((f) => f.text)).toEqual(['is making smasnug AI faster', 'prefers short answers', 'knows Rust']);
    // The merge keeps the newest statement time of the group.
    expect(left[0]!.statedAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');

    const audit = await sql<{ factId: string; action: string; text: string; mergedInto: string | null }[]>`
      select fact_id, action, text, merged_into from memory_pruned where user_id = ${user} order by id`;
    expect(audit.map((a) => [Number(a.factId), a.action, a.text])).toEqual([
      [ids.cheese, 'removed', 'is adding cheese-swapped caption emojis to the workspace'],
      [ids.improve, 'merged', 'is making improvements to smasnug AI'],
      [ids.faster, 'merged', 'is optimizing smasnug AI for faster initial responses'],
    ]);

    // A new fact the same day doesn't trigger another pass.
    await sql`insert into user_memory (user_id, text, kind) values (${user}, 'is adding cheese-swapped emoji again', 'project')`;
    await prune.runMemoryPrune();
    expect(calls).toBe(1);
  });

  it('skips an op whose fact changed during the model call, and applies the rest', async () => {
    const u2 = 'U_MEMPRUNE2';
    await sql`delete from user_memory where user_id = ${u2}`;
    for (const [key, text] of [['stale', 'stale-marker one-off task'], ['stale2', 'made one emoji once'], ['x', 'knows Go'], ['y', 'knows Rust']] as const) {
      const [r] = await sql<{ id: string }[]>`insert into user_memory (user_id, text, kind) values (${u2}, ${text}, 'project') returning id`;
      ids[key] = Number(r!.id);
    }
    await prune.pruneUser(u2);
    const left = (await sql<{ text: string }[]>`select text from user_memory where user_id = ${u2} order by id`).map((r) => r.text);
    expect(left).toEqual(['stale-marker edited meanwhile', 'knows Go', 'knows Rust']);
    const audit = await sql<{ text: string }[]>`select text from memory_pruned where user_id = ${u2}`;
    expect(audit.map((a) => a.text)).toEqual(['made one emoji once']);
    await sql`delete from user_memory where user_id = ${u2}`;
    await sql`delete from memory_pruned where user_id = ${u2}`;
  });

  it('deleting a merged fact deletes the copies it was made from', async () => {
    const store = await import('./store.js');
    expect(await store.deleteFact(user, ids.improve!)).toBe(true);
    const rows = await sql<{ factId: string }[]>`select fact_id from memory_pruned where user_id = ${user}`;
    expect(rows.map((r) => Number(r.factId))).toEqual([ids.cheese]);
  });

  it('forget everything also deletes the audit copies', async () => {
    const store = await import('./store.js');
    await store.deleteAllFacts(user);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from memory_pruned where user_id = ${user}`;
    expect(row?.n).toBe(0);
  });
});
