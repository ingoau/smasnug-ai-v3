/**
 * send_message's `#name` lookup against the fake Slack and the test Redis: the bot's own channels (users.conversations,
 * incl. private ones) first, then the workspace scan (conversations.list).
 *   INTEGRATION=1 pnpm vitest run src/features/send/resolve.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.LOG_LEVEL = 'silent';
});

describe.skipIf(!INTEGRATION)('send_message channel names', () => {
  let redis: typeof import('../../core/redis.js').redis;
  let fake: typeof import('../../core/slack-fake.js');
  let S: typeof import('./send.js');
  let remove: () => void;
  let memberPages: { id: string; name: string }[][] = [];
  const counts = { member: 0, list: 0 };

  beforeAll(async () => {
    ({ redis } = await import('../../core/redis.js'));
    fake = await import('../../core/slack-fake.js');
    S = await import('./send.js');
    remove = fake.addFakeHandler((method, args) => {
      if (method === 'users.conversations') {
        counts.member++;
        expect(args.types).toBe('public_channel,private_channel');
        const page = Number(args.cursor ?? 0);
        return { ok: true, channels: memberPages[page] ?? [], response_metadata: { next_cursor: page + 1 < memberPages.length ? String(page + 1) : '' } };
      }
      if (method === 'conversations.list') counts.list++;
      return undefined;
    });
  });

  beforeEach(async () => {
    await redis.del('features:botchans');
    counts.member = 0;
    counts.list = 0;
  });

  afterAll(async () => {
    remove?.();
    redis.disconnect();
  });

  it("a private channel the bot is in is found among its memberships, without scanning the workspace's list", async () => {
    memberPages = [[{ id: 'CPUB1', name: 'general' }], [{ id: 'GPRIV1', name: 'Smasnug-AI-Testing' }]];
    expect(await S.resolveChannelName('smasnug-ai-testing')).toBe('GPRIV1');
    expect(counts.member).toBe(2); // both pages
    expect(counts.list).toBe(0);
    // Cached: no second users.conversations call.
    expect(await S.resolveChannelName('general')).toBe('CPUB1');
    expect(counts.member).toBe(2);
  });

  it('not a member: falls back to the workspace list; nothing anywhere → undefined', async () => {
    memberPages = [[{ id: 'CPUB1', name: 'general' }]];
    expect(await S.resolveChannelName('random')).toBe('CRANDOM'); // the fake conversations.list
    expect(counts.list).toBe(1);
    expect(await S.resolveChannelName(`nope-${Date.now()}`)).toBeUndefined();
    expect(counts.member).toBe(1); // the fresh membership copy isn't re-fetched within a minute
  });

  it('a stale membership copy is re-fetched once on a miss (the bot joined since)', async () => {
    await redis.set('features:botchans', JSON.stringify({ at: Date.now() - 5 * 60_000, channels: { general: 'CPUB1' } }));
    memberPages = [[{ id: 'CPUB1', name: 'general' }, { id: 'GNEW', name: 'just-joined' }]];
    expect(await S.botChannelId('just-joined')).toBe('GNEW');
    expect(counts.member).toBe(1);
  });
});
