/**
 * slack_search through the real shared limiter (SLACK_FAKE_LIMITER=1) against the fake Slack and the test Redis:
 *   INTEGRATION=1 pnpm vitest run src/tools/slack-search.int
 * A burst of subagent searches never waits longer than limits.slackSearchMaxWaitMs (the excess gets the busy result),
 * waiting searches are served in order, and a front-agent (interactive) search gets a slot while subagent
 * (background) searches are queued. Uses the production window (search.messages: 20 per 30 s, 4 reserved).
 */
import './test-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';

describe.skipIf(!INTEGRATION)('slack_search under the shared rate limit', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let toolsFor: typeof import('../core/tools.js').toolsFor;
  let S: typeof import('./slack-search.js');
  let limits: typeof import('../config.js').limits;
  let rateLimitKey: typeof import('../core/slack.js').rateLimitKey;
  const removers: (() => void)[] = [];
  const prevLimiter = process.env.SLACK_FAKE_LIMITER;

  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  const PUB = `C3SSPUB${r}`;
  const channel = `C3SS${r}`;
  const rootTs = '1790000000.000100';
  let served: string[] = [];
  const exec = (t: any, input: any) => t.execute(input, { toolCallId: 'tc1', messages: [] });
  const ctx = (extras: Record<string, unknown> = {}) => ({
    threadId: `${channel}:${rootTs}`,
    channelId: channel,
    threadTs: rootTs,
    speakerId: `U3SS${r}`,
    turnId: 1,
    extras,
  });
  let n = 0;
  const q = (s: string) => `ss3${r} ${s} ${n++}`; // unique: no cache hits
  const PER_MIN = 20; // slots per window
  const WINDOW_MS = 30_000;

  let key = '';
  const clearLimiter = () => redis.del(key, `${key}:qi`, `${key}:qb`, `${key}:seen`);
  /** Window entries: `fresh` just now, plus one per `expiresInMs` that leaves the window after that long. */
  const fill = async (fresh: number, expiresInMs: number[] = []) => {
    const now = Date.now();
    for (let i = 0; i < fresh; i++) await redis.zadd(key, now, `${now}:fresh${i}`);
    for (const [i, ms] of expiresInMs.entries()) await redis.zadd(key, now - WINDOW_MS + ms, `${now}:exp${i}`);
  };

  beforeAll(async () => {
    process.env.SLACK_FAKE_LIMITER = '1';
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ toolsFor } = await import('../core/tools.js'));
    ({ limits } = await import('../config.js'));
    ({ rateLimitKey } = await import('../core/slack.js'));
    await import('./index.js');
    S = await import('./slack-search.js');
    key = rateLimitKey('user', 'search.messages');
    const { addFakeHandler } = await import('../core/slack-fake.js');
    removers.push(
      addFakeHandler((method, args) => {
        if (method === 'conversations.info' && args.channel === PUB) return { ok: true, channel: { id: PUB, name: 'ship', is_channel: true, is_private: false } };
        if (method !== 'search.messages' || !String(args.query).startsWith(`ss3${r}`)) return undefined;
        served.push(String(args.query));
        return {
          ok: true,
          messages: { matches: [{ channel: { id: PUB, name: 'ship' }, user: 'U3SSBOB', ts: '1790000001.000100', text: `hit for ${args.query}`, permalink: `https://x.slack.com/archives/${PUB}/p1790000001000100` }] },
        };
      }),
    );
  });

  beforeEach(async () => {
    served = [];
    await clearLimiter();
  });

  afterAll(async () => {
    for (const rm of removers) rm();
    if (prevLimiter === undefined) delete process.env.SLACK_FAKE_LIMITER;
    else process.env.SLACK_FAKE_LIMITER = prevLimiter;
    if (key) await clearLimiter();
    await sql?.end();
  });

  it('30 concurrent subagent searches: the background share is served, the rest get the busy result fast', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const t0 = Date.now();
        const out: string = await exec(toolsFor('child', ctx()).slack_search, { query: q(`burst${i}`) });
        return { out, ms: Date.now() - t0 };
      }),
    );
    const ok = results.filter((x) => x.out.includes('public channels only'));
    const busy = results.filter((x) => x.out.startsWith('Slack search is rate limited right now'));
    expect(ok).toHaveLength(PER_MIN - limits.slackSearchInteractiveReserve);
    expect(busy).toHaveLength(30 - ok.length);
    for (const x of results) expect(x.ms).toBeLessThan(limits.slackSearchMaxWaitMs);
    // The busy ones knew up front: no slot frees within maxWaitMs, so they didn't sit it out.
    for (const x of busy) expect(x.ms).toBeLessThan(1500);
    expect(served).toHaveLength(ok.length);

    // A user's question in a front-agent turn still gets one of the reserved slots right away.
    const t0 = Date.now();
    const front: string = await exec(toolsFor('front', ctx()).slack_search, { query: q('front') });
    expect(front).toContain('public channels only');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('waiting searches are served in arrival order, each within maxWaitMs, and report their wait', async () => {
    // Full window; the oldest 5 entries leave it 400, 700, 1000, 1300, 1600 ms from now.
    await fill(PER_MIN - 5, [400, 700, 1000, 1300, 1600]);
    const waits: any[] = [];
    const runs: Promise<{ ms: number; out: string }>[] = [];
    const queries: string[] = [];
    for (let i = 0; i < 5; i++) {
      const query = q(`fifo${i}`);
      queries.push(query);
      const t0 = Date.now();
      runs.push(exec(toolsFor('front', ctx({ [S.SLACK_WAIT_EXTRA]: (ev: any) => waits.push(ev) })).slack_search, { query }).then((out: string) => ({ out, ms: Date.now() - t0 })));
      await new Promise((res) => setTimeout(res, 20));
    }
    const done = await Promise.all(runs);
    expect(served).toEqual(queries);
    for (const d of done) {
      expect(d.out).toContain('public channels only');
      expect(d.ms).toBeLessThan(limits.slackSearchMaxWaitMs);
    }
    expect(waits.filter((e) => !e.done)).toHaveLength(5);
    expect(waits.filter((e) => e.done)).toHaveLength(5);
    expect(waits.every((e) => e.method === 'search.messages' && e.reason === 'rate_limit')).toBe(true);
  });

  it('an interactive search gets a slot while background searches are queued', async () => {
    // Full window; slots free every 200 ms from 300 ms on. Background needs the count under 16 (4 reserved).
    await fill(PER_MIN - 8, [300, 500, 700, 900, 1100, 1300, 1500, 1700]);
    const order: string[] = [];
    const bg: Promise<string>[] = [];
    for (const i of [0, 1]) {
      bg.push(exec(toolsFor('child', ctx()).slack_search, { query: q(`bg${i}`) }).then((out: string) => (order.push(`bg${i}`), out)));
      await new Promise((res) => setTimeout(res, 40)); // queued in this order
    }
    const t0 = Date.now();
    const fg = exec(toolsFor('front', ctx()).slack_search, { query: q('fg') }).then((out: string) => (order.push('fg'), { out, ms: Date.now() - t0 }));
    const [b0, b1, f] = await Promise.all([...bg, fg]);
    expect(order[0]).toBe('fg');
    expect(f.out).toContain('public channels only');
    expect(f.ms).toBeLessThan(600);
    expect(b0).toContain('public channels only');
    expect(b1).toContain('public channels only');
    expect(order.slice(1)).toEqual(['bg0', 'bg1']);
  });

  it("conversations.info busy: unverified channels' matches are dropped (fail closed) with a note, fast, and not cached", async () => {
    const NEW = `C3SSNEW${r}`;
    const infoKey = rateLimitKey('bot', 'conversations.info');
    const { addFakeHandler } = await import('../core/slack-fake.js');
    const remove = addFakeHandler((method, args) => {
      if (method !== 'search.messages' || !String(args.query).startsWith(`ss3new${r}`)) return undefined;
      return {
        ok: true,
        messages: {
          matches: [
            { channel: { id: NEW, name: 'unverified' }, user: 'U3SSBOB', ts: '1790000002.000100', text: 'in an unverified channel', permalink: `https://x.slack.com/archives/${NEW}/p1790000002000100` },
            { channel: { id: PUB, name: 'ship' }, user: 'U3SSBOB', ts: '1790000003.000100', text: 'in the known public channel', permalink: `https://x.slack.com/archives/${PUB}/p1790000003000100` },
          ],
        },
      };
    });
    try {
      await S.publicChannelNames([PUB]); // PUB verified (cached) before the limiter fills up
      const now = Date.now();
      for (let i = 0; i < 50; i++) await redis.zadd(infoKey, now, `${now}:info${i}`);
      const waits: any[] = [];
      const t0 = Date.now();
      const out: string = await exec(toolsFor('child', ctx({ [S.SLACK_WAIT_EXTRA]: (ev: any) => waits.push(ev) })).slack_search, { query: `ss3new${r} q` });
      expect(Date.now() - t0).toBeLessThan(limits.slackSearchMaxWaitMs);
      expect(out).toContain('in the known public channel');
      expect(out).not.toContain('in an unverified channel');
      expect(out).toMatch(/1 more result was skipped because Slack's rate limit kept me from checking that its channel is public/);
      expect(await redis.get(S.searchCacheKey(`ss3new${r} q`, undefined))).toBeNull(); // incomplete: not cached
      expect(await redis.get(`slack:chanvis:${NEW}`)).toBeNull(); // unverified: not cached as private either

      // A link into that channel fails closed with a rate-limit message, not a silent stall or "not visible".
      const t1 = Date.now();
      const read: string = await exec(toolsFor('child', ctx()).read_public_thread, { permalink: `https://x.slack.com/archives/${NEW}/p1790000002000100` });
      expect(Date.now() - t1).toBeLessThan(limits.slackToolMaxWaitMs);
      expect(read).toMatch(/^Slack is rate limited right now .* so that thread couldn't be read/);
    } finally {
      remove();
      await redis.del(infoKey, `${infoKey}:qi`, `${infoKey}:qb`, `${infoKey}:seen`);
    }
  });
});
