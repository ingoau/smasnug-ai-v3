import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { limits } from '../config.js';
import { lowQuotaLines, takeLimit, userQuotaStates } from './guard.js';

const user = `UQ${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

afterAll(async () => {
  const keys = await redis.keys(`limit:*:${user}`);
  if (keys.length) await redis.del(...keys);
  await sql`delete from usage where user_id = ${user}`;
  await sql.end();
  redis.disconnect();
});

describe('userQuotaStates', () => {
  it('reads the sliding windows without counting, and warns once a limit is close', async () => {
    const fresh = await userQuotaStates(user);
    expect(fresh.find((q) => q.kind === 'semantic_search')).toMatchObject({ max: limits.userSemanticSearchesPerHour, remaining: limits.userSemanticSearchesPerHour });
    expect(lowQuotaLines(fresh)).toBe('');
    for (let i = 0; i < limits.userSemanticSearchesPerHour - 1; i++) expect(await takeLimit('semantic_search', user)).toBeNull();
    const states = await userQuotaStates(user);
    expect(states.find((q) => q.kind === 'semantic_search')!.remaining).toBe(1);
    // Reading didn't count: one is still left.
    expect((await userQuotaStates(user)).find((q) => q.kind === 'semantic_search')!.remaining).toBe(1);
    expect(lowQuotaLines(states)).toBe(`Semantic Slack searches: only 1 left this hour (max ${limits.userSemanticSearchesPerHour}/hour).`);
  });
});
