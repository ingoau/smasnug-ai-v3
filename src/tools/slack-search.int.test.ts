/**
 * slack_search through the real shared limiter (SLACK_FAKE_LIMITER=1) against the fake Slack and the test Redis:
 *   INTEGRATION=1 pnpm vitest run src/tools/slack-search.int
 * A burst of subagent (background) searches larger than the background share waits for the window to refill and is
 * served within about one window (none busy), waiting searches are served in order, and a front-agent (interactive)
 * search gets a reserved slot while subagent searches are queued. Uses the production window (search.messages: 20 per
 * 30 s, 4 reserved), so the burst test takes ~30 s.
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
  let pauseKey: typeof import('../core/slack.js').pauseKey;
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
    ({ rateLimitKey, pauseKey } = await import('../core/slack.js'));
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

  it('30 concurrent subagent searches all succeed within about one window; a front-agent search mid-burst gets a reserved slot fast', async () => {
    const waits: any[] = [];
    const t0 = Date.now();
    const burst = Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const out: string = await exec(toolsFor('child', ctx({ [S.SLACK_WAIT_EXTRA]: (ev: any) => waits.push(ev) })).slack_search, { query: q(`burst${i}`) });
        return { out, ms: Date.now() - t0 };
      }),
    );

    // Mid-burst: the background share (16) is used up and the rest are queued; a user's question still gets one of the
    // 4 reserved slots right away.
    await new Promise((res) => setTimeout(res, 2000));
    expect(served).toHaveLength(PER_MIN - limits.slackSearchInteractiveReserve);
    const t1 = Date.now();
    const front: string = await exec(toolsFor('front', ctx()).slack_search, { query: q('front') });
    expect(front).toContain('public channels only');
    expect(Date.now() - t1).toBeLessThan(1000);

    const results = await burst;
    expect(results.filter((x) => !x.out.includes('public channels only'))).toEqual([]); // none busy
    expect(served).toHaveLength(31);
    const waited = results.filter((x) => x.ms > 5000);
    // The 14 over the background share waited for the window to refill: about one window, within the background cap.
    expect(waited).toHaveLength(30 - (PER_MIN - limits.slackSearchInteractiveReserve));
    for (const x of waited) {
      expect(x.ms).toBeGreaterThan(WINDOW_MS - 2000);
      expect(x.ms).toBeLessThan(limits.slackSearchBackgroundMaxWaitMs);
    }
    // Each waiting search reported its wait (start + end) for the card label.
    const searchWaits = waits.filter((e) => e.method === 'search.messages' && e.reason === 'rate_limit');
    expect(searchWaits.filter((e) => !e.done)).toHaveLength(waited.length);
    expect(searchWaits.filter((e) => e.done)).toHaveLength(waited.length);
    for (const e of searchWaits.filter((x) => !x.done)) expect(e.estimateMs).toBeGreaterThan(WINDOW_MS - 3000);
  }, 60_000);

  it('a background search whose wait would exceed the background cap gets the busy result up front, with when to retry', async () => {
    // A long 429 pause (Retry-After past the cap).
    const pause = pauseKey('user', 'search.messages');
    await redis.set(pause, String(Date.now() + 45_000), 'PX', 45_000);
    try {
      const t0 = Date.now();
      const out: string = await exec(toolsFor('child', ctx()).slack_search, { query: q('paused') });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(out).toMatch(/^Slack search is rate limited right now \(~4[45]s until a slot frees/);
      expect(out).toMatch(/search again in ~4[45]s/);
      expect(served).toHaveLength(0);
    } finally {
      await redis.del(pause);
    }
  });

  it('waiting front-agent searches are served in arrival order, each within the interactive cap, and report their wait', async () => {
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
      // The info window is full for ~60 s, past even the background cap: skipped up front, not waited out.
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
