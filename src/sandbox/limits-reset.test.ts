import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { dailyWindowStart, resetUserLimits, takeLimit, userQuotaStates } from '../features/guard.js';
import { userMinutesToday } from './budget.js';
import { previewCountsToday } from './preview/store.js';

const user = `UR${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

afterAll(async () => {
  const keys = await redis.keys(`limit:*:${user}`);
  if (keys.length) await redis.del(...keys);
  await sql`delete from usage where user_id = ${user}`;
  await sql`delete from sandbox_usage where user_id = ${user}`;
  await sql`delete from previews where requester_id = ${user}`;
  await sql.end();
  redis.disconnect();
});

describe('dailyWindowStart', () => {
  const day = new Date('2026-11-19T00:00:00Z');
  it('moves to a reset inside the day, ignores an older one', () => {
    expect(dailyWindowStart(day, null)).toEqual(day);
    expect(dailyWindowStart(day, new Date('2026-11-18T23:00:00Z'))).toEqual(day);
    expect(dailyWindowStart(day, new Date('2026-11-19T08:00:00Z'))).toEqual(new Date('2026-11-19T08:00:00Z'));
  });
});

describe('resetUserLimits', () => {
  it('clears hourly windows, sandbox minutes and live previews, keeping the usage rows', async () => {
    // A 10-minute closed segment and an open one started 5 minutes ago (capped at today's start near midnight).
    await sql`insert into sandbox_usage (sandbox_id, user_id, thread_id, cpu, memory_mib, started_at, ended_at)
      values ('sb_reset_a', ${user}, 'C:1', 1, 1024, greatest(now() - interval '11 minutes', date_trunc('day', now() at time zone 'utc') at time zone 'utc'), now() - interval '1 minute'),
             ('sb_reset_b', ${user}, 'C:1', 1, 1024, greatest(now() - interval '5 minutes', date_trunc('day', now() at time zone 'utc') at time zone 'utc'), null)`;
    await sql`insert into previews (id, thread_id, requester_id, title, status) values (${`pv_${user}`}, 'C:1', ${user}, 'x', 'live')`;
    expect(await takeLimit('fetch', user)).toBeNull();

    expect(await userMinutesToday(user)).toBeGreaterThan(0);
    expect((await previewCountsToday(user)).user).toBe(1);
    const fetchLeft = () => userQuotaStates(user).then((s) => s.find((q) => q.kind === 'fetch')!);
    expect((await fetchLeft()).remaining).toBe((await fetchLeft()).max - 1);

    await resetUserLimits(user);

    expect(await userMinutesToday(user)).toBeLessThan(0.1); // only the open segment's last instant counts
    expect((await previewCountsToday(user)).user).toBe(0);
    expect((await fetchLeft()).remaining).toBe((await fetchLeft()).max);
    const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from sandbox_usage where user_id = ${user}`;
    expect(rows!.n).toBe(2);
  });
});
