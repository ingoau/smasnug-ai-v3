/**
 * slack_semantic_search (Slack Real-time Search): argument building, result mapping/formatting, `##` filtering,
 * the fail-closed public-channel filter, and the limits (per turn, per user/hour, Slack's per-minute limit).
 */
import './test-env.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler, fakeSlackError } from '../core/slack-fake.js';
import { threadIdOf } from '../core/events.js';
import { toolsFor, type ToolContext } from '../core/tools.js';
import { compactHistory } from '../agent/util.js';
import './index.js';
import { buildRtsArgs, dayToUnix, rtsToMatch, semanticSearchError, MAX_CALLS_PER_TURN } from './slack-semantic-search.js';
import { SlackBusyError } from '../core/slack.js';

const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const rootTs = '1790000000.000100';
const threadId = threadIdOf(channel, rootTs);
const removers: (() => void)[] = [];
const uid = () => `U1RTS${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ctx = (speakerId = uid()): Omit<ToolContext, 'role'> => ({ threadId, channelId: channel, threadTs: rootTs, speakerId, turnId: 1, extras: {} });
const exec = (t: any, input: any) => t.execute(input, { toolCallId: 'tc1', messages: [] });

// conversations.info as Slack reports it; unknown ids → channel_not_found (private, bot not a member).
const INFO: Record<string, any> = {
  C1RTSPUB: { id: 'C1RTSPUB', name: 'ship', is_channel: true, is_private: false },
  C1RTSPUB2: { id: 'C1RTSPUB2', name: 'lounge', is_channel: true, is_private: false },
  C1RTSPRIV: { id: 'C1RTSPRIV', name: 'staff', is_channel: true, is_private: true },
  C1RTSFLAKY: 'error',
};

const result = (n: string, channelId: string, channelName: string, content: string, extra: any = {}) => ({
  author_name: 'Alice Example',
  author_user_id: 'U1RTSALICE',
  team_id: 'T0123456',
  channel_id: channelId,
  channel_name: channelName,
  message_ts: `17900000${n}.000100`,
  content,
  is_author_bot: false,
  permalink: `https://fixture.slack.com/archives/${channelId}/p17900000${n}000100`,
  context_messages: {
    before: [
      { text: `older context ${n}`, user_id: 'U1RTSBOB', ts: `17900000${n}.000001` },
      { text: `just before ${n}`, 'user_id:': 'U1RTSBOB', ts: `17900000${n}.000002` },
      { text: '## hidden before', user_id: 'U1RTSBOB', ts: `17900000${n}.000003` },
    ],
    after: [
      { text: `just after ${n}`, user_id: 'U1RTSBOB', ts: `17900000${n}.000200` },
      { text: `later ${n}`, user_id: 'U1RTSBOB', ts: `17900000${n}.000300` },
      { text: 'way later (dropped: only two kept)', user_id: 'U1RTSBOB', ts: `17900000${n}.000400` },
    ],
  },
  ...extra,
});

const RESULTS = [
  result('01', 'C1RTSPUB', 'ship', 'Priya was organising the Berlin hackathon <@U1RTSBOB>'),
  result('02', 'C1RTSPRIV', 'staff', 'secret staff talk'), // private per conversations.info
  result('03', 'D1RTSDM', 'dm', 'dm text'), // not a C… id
  result('04', 'G1RTSOLD', 'old-private', 'old private group'),
  result('05', 'C1RTSUNKNOWN', 'mystery', 'unknown channel text'), // channel_not_found
  result('06', 'C1RTSFLAKY', 'flaky', 'flaky lookup text'), // lookup error → excluded
  result('07', 'C1RTSPUB', 'ship', '## hidden search hit'),
  result('08', 'C1RTSPUB2', 'lounge', 'a reply in a thread', { thread_ts: '1790000007.000100' }),
];

let rtsCalls: { args: any; token: string }[] = [];
let rtsBehaviour: 'results' | 'ratelimited' | 'feature_not_enabled' | 'empty' = 'results';
let aiSearch: boolean | 'error' = true;

removers.push(
  addFakeHandler((method, args, token) => {
    if (method === 'conversations.info' && String(args.channel).startsWith('C1RTS')) {
      const info = INFO[String(args.channel)];
      if (info === 'error') throw fakeSlackError('internal_error');
      if (!info) throw fakeSlackError('channel_not_found');
      return { ok: true, channel: info };
    }
    if (method === 'assistant.search.info') {
      if (aiSearch === 'error') throw fakeSlackError('missing_scope');
      return { ok: true, is_ai_search_enabled: aiSearch };
    }
    if (method === 'assistant.search.context') {
      rtsCalls.push({ args, token });
      if (rtsBehaviour === 'ratelimited') throw fakeSlackError('ratelimited');
      if (rtsBehaviour === 'feature_not_enabled') throw fakeSlackError('feature_not_enabled');
      return { ok: true, results: { messages: rtsBehaviour === 'empty' ? [] : RESULTS }, response_metadata: { next_cursor: 'abc' } };
    }
    return undefined;
  }),
);

beforeEach(async () => {
  rtsCalls = [];
  rtsBehaviour = 'results';
  aiSearch = true;
  const keys = [...(await redis.keys('slack:chanvis:C1RTS*')), 'slack:rts:ai_search', 'slack:rl:user:assistant.search.context'];
  await redis.del(...keys);
});

afterAll(async () => {
  removers.forEach((r) => r());
  await sql`delete from usage where user_id like 'U1RTS%'`;
  await sql.end();
});

describe('arguments', () => {
  it('public channels, messages only, context on, score sort (semantic), max page', () => {
    expect(buildRtsArgs({ query: '  who organised the hackathon? ' })).toEqual({
      query: 'who organised the hackathon?',
      channel_types: 'public_channel',
      content_types: 'messages',
      include_context_messages: true,
      include_bots: true,
      highlight: false,
      sort: 'score',
      sort_dir: 'desc',
      limit: 20,
    });
  });

  it('dates become unix bounds; before includes the whole day; junk is ignored', () => {
    expect(dayToUnix('2026-09-01')).toBe(Date.UTC(2026, 8, 1) / 1000);
    expect(dayToUnix('yesterday')).toBeUndefined();
    expect(dayToUnix(undefined)).toBeUndefined();
    const a = buildRtsArgs({ query: 'q', after: '2026-09-01', before: '2026-09-02' });
    expect(a.after).toBe(Date.UTC(2026, 8, 1) / 1000);
    expect(a.before).toBe(Date.UTC(2026, 8, 3) / 1000);
    expect(buildRtsArgs({ query: 'q', after: 'last week' })).not.toHaveProperty('after');
  });
});

describe('result mapping', () => {
  it('maps to the search.messages shape, keeping the nearest two context messages per side', () => {
    const m = rtsToMatch(RESULTS[0]);
    expect(m.channel).toEqual({ id: 'C1RTSPUB', name: 'ship' });
    expect(m).toMatchObject({ user: 'U1RTSALICE', username: 'Alice Example', ts: '1790000001.000100', text: RESULTS[0]!.content });
    expect(m.previous_2.text).toBe('just before 01'); // the nearest two before: "just before", "## hidden before"
    expect(m.previous.text).toBe('## hidden before');
    expect(m.previous_2.user).toBe('U1RTSBOB'); // `user_id:` (sic, from Slack's docs) accepted
    expect(m.next.text).toBe('just after 01');
    expect(m.next_2.text).toBe('later 01');
    expect(rtsToMatch({ channel_id: 'C1', message_ts: '1.2', content: 'x', context_messages: { before: [{ text: 'b', ts: '1.1' }] } }).previous.text).toBe('b');
    expect(rtsToMatch({}).channel).toBeUndefined();
  });

  it('errors always point back at slack_search', () => {
    expect(semanticSearchError(new SlackBusyError('x', 30_000))).toMatch(/busy.*Use slack_search instead/);
    expect(semanticSearchError(fakeSlackError('ratelimited'))).toMatch(/busy.*Use slack_search instead/);
    expect(semanticSearchError(fakeSlackError('missing_scope'))).toBe('Semantic search is unavailable (missing_scope). Use slack_search instead.');
  });
});

describe('slack_semantic_search tool', () => {
  it('is granted to front and child', () => {
    expect(toolsFor('front', ctx())).toHaveProperty('slack_semantic_search');
    expect(toolsFor('child', ctx())).toHaveProperty('slack_semantic_search');
    expect(toolsFor('gate', ctx())).not.toHaveProperty('slack_semantic_search');
  });

  it('uses the user token; only verified public channels; ## hits and ## context dropped; no totals or cursors', async () => {
    const out: string = await exec(toolsFor('child', ctx()).slack_semantic_search, { query: 'who was organising the Berlin hackathon?' });
    expect(rtsCalls).toHaveLength(1);
    expect(rtsCalls[0]!.token).toBe('user');
    expect(rtsCalls[0]!.args).toMatchObject({ channel_types: 'public_channel', content_types: 'messages', query: 'who was organising the Berlin hackathon?' });
    expect(out).toMatch(/^<untrusted_content source="slack semantic search">/);
    expect(out).toContain('(2 shown, public channels only)');
    expect(out).toContain('<#C1RTSPUB|ship>');
    expect(out).toContain('<#C1RTSPUB2|lounge>');
    expect(out).toContain('https://fixture.slack.com/archives/C1RTSPUB/p1790000001000100');
    expect(out).toContain('Priya was organising the Berlin hackathon');
    expect(out).toContain('<#C1RTSPUB|ship> · <@U1RTSALICE> User U1RTSALICE · ts 1790000001.000100'); // author name from users.info
    expect(out).toContain('just after 01');
    expect(out).toContain('↳ reply in thread 1790000007.000100'); // thread marker for the reply
    for (const leak of ['secret staff', 'staff', 'dm text', 'old private', 'mystery', 'unknown channel', 'flaky', 'C1RTSPRIV', 'D1RTSDM', 'G1RTSOLD', 'C1RTSUNKNOWN', 'C1RTSFLAKY', 'hidden', 'abc', 'way later']) {
      expect(out).not.toContain(leak);
    }
  });

  it('notes when Slack AI Search is off (keyword fallback); unknown capability adds nothing', async () => {
    aiSearch = false;
    const off: string = await exec(toolsFor('front', ctx()).slack_semantic_search, { query: 'what is the deal with the orpheus plush?' });
    expect(off).toContain('Slack AI Search is off in this workspace');
    await redis.del('slack:rts:ai_search');
    aiSearch = 'error';
    const unknown: string = await exec(toolsFor('front', ctx()).slack_semantic_search, { query: 'what is the deal with the orpheus plush?' });
    expect(unknown).not.toContain('AI Search');
    expect(unknown).toContain('(2 shown, public channels only)');
  });

  it('no public results → says so and suggests slack_search', async () => {
    rtsBehaviour = 'empty';
    expect(await exec(toolsFor('front', ctx()).slack_semantic_search, { query: 'what?' })).toMatch(/^No public-channel results for "what\?"\. Try slack_search/);
  });

  it('Slack errors come back as a short message pointing at slack_search', async () => {
    rtsBehaviour = 'feature_not_enabled';
    expect(await exec(toolsFor('front', ctx()).slack_semantic_search, { query: 'q?' })).toBe('Semantic search is unavailable (feature_not_enabled). Use slack_search instead.');
    rtsBehaviour = 'ratelimited';
    expect(await exec(toolsFor('front', ctx()).slack_semantic_search, { query: 'q?' })).toMatch(/^Semantic search is busy right now.*Use slack_search instead\.$/);
  });
});

describe('limits', () => {
  it(`at most ${MAX_CALLS_PER_TURN} calls per turn/run (per built tool set)`, async () => {
    const t = toolsFor('front', ctx()).slack_semantic_search;
    for (let i = 0; i < MAX_CALLS_PER_TURN; i++) expect(await exec(t, { query: `q${i}?` })).toContain('shown');
    expect(await exec(t, { query: 'again?' })).toMatch(/already used 2 times this turn\. Use slack_search instead\./);
    expect(rtsCalls).toHaveLength(MAX_CALLS_PER_TURN);
    // A new turn gets a fresh allowance.
    expect(await exec(toolsFor('front', ctx()).slack_semantic_search, { query: 'new turn?' })).toContain('shown');
  });

  it('counts against the per-user hourly limit and refuses when over it, without calling Slack', async () => {
    const user = uid();
    await exec(toolsFor('front', ctx(user)).slack_semantic_search, { query: 'q?' });
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from usage where user_id = ${user} and kind = 'semantic_search'`;
    expect(row!.n).toBe(1);
    const now = Date.now();
    const fill: (string | number)[] = [];
    for (let i = 0; i < 20; i++) fill.push(now, `fill${i}`);
    await redis.zadd(`limit:semantic_search:${user}`, ...fill);
    rtsCalls = [];
    expect(await exec(toolsFor('front', ctx(user)).slack_semantic_search, { query: 'q2?' })).toBe(
      'Limit reached: at most 20 semantic searches per hour for this user. Use slack_search instead.',
    );
    expect(rtsCalls).toHaveLength(0);
  });

  it("Slack's per-minute limit full → returns fast with a slack_search hint instead of queueing", async () => {
    const prev = process.env.SLACK_FAKE_LIMITER;
    process.env.SLACK_FAKE_LIMITER = '1'; // run the shared limiter in fake mode
    try {
      const now = Date.now();
      const fill: (string | number)[] = [];
      for (let i = 0; i < 10; i++) fill.push(now, `busy${i}`);
      await redis.zadd('slack:rl:user:assistant.search.context', ...fill);
      const started = Date.now();
      const out = await exec(toolsFor('front', ctx()).slack_semantic_search, { query: 'q?' });
      expect(out).toBe('Semantic search is busy right now (Slack rate limit). Use slack_search instead.');
      expect(Date.now() - started).toBeLessThan(5000);
      expect(rtsCalls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.SLACK_FAKE_LIMITER;
      else process.env.SLACK_FAKE_LIMITER = prev;
    }
  });
});

describe('persistence', () => {
  it("subagent history compaction never keeps Real-time Search results (Slack's no-storage rule)", () => {
    const out = compactHistory([
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'slack_semantic_search', output: { type: 'text', value: 'Priya was organising' } }] },
    ]);
    expect((out[0] as any).content[0].output).toEqual({ type: 'text', value: '[search results not stored]' });
  });
});
