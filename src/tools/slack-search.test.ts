/**
 * slack_search: the short-lived result cache (public matches only, re-checked on a hit),
 * in-flight sharing, the fail-fast busy result and the soft per-run budget note. The limiter itself is covered in
 * src/core/slack-limiter.test.ts and, end to end with the fake Slack, in slack-search.int.test.ts.
 */
import './test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { limits } from '../config.js';
import { redis } from '../core/redis.js';
import { addFakeHandler } from '../core/slack-fake.js';
import { SlackBusyError } from '../core/slack.js';
import { threadIdOf } from '../core/events.js';
import { toolsFor, type ToolContext } from '../core/tools.js';
import { getUserNames } from '../context/users.js';
import './index.js';
import { formatSearchMatches, searchBudgetNote, searchBusyText, searchCacheKey, searchUserIds, slimMatch } from './slack-search.js';

const r = Math.random().toString(36).slice(2, 8).toUpperCase();
const channel = `C2SS${r}`;
const rootTs = '1790000000.000100';
const threadId = threadIdOf(channel, rootTs);
const PUB = `C2SSPUB${r}`;
const PUB2 = `C2SSPUBB${r}`;
const PRIV = `C2SSPRIV${r}`;
const ctx = (extras: Record<string, unknown> = {}): Omit<ToolContext, 'role'> => ({
  threadId,
  channelId: channel,
  threadTs: rootTs,
  speakerId: `U2SS${r}`,
  turnId: 1,
  extras,
});
const exec = (t: any, input: any) => t.execute(input, { toolCallId: 'tc1', messages: [] });

const match = (n: string, chan: string, text: string, extra: any = {}) => ({
  channel: { id: chan, name: chan === PUB ? 'ship' : 'other', is_private: false },
  user: 'U2SSBOB',
  username: 'bob',
  ts: `17900000${n}.000100`,
  text,
  permalink: `https://fixture.slack.com/archives/${chan}/p17900000${n}000100`,
  iid: 'x',
  team: 'T0',
  blocks: [{ type: 'rich_text' }],
  ...extra,
});

const MATCHES = [
  match('01', PUB, 'the cache plan <@U2SSALICE>', {
    attachments: [{ is_share: true, author_name: 'Carol', text: 'forwarded body' }],
    previous_2: { ts: '1790000000.000001', user: 'U2SSBOB', text: 'two before' },
    previous: { ts: '1790000000.000002', user: 'U2SSBOB', text: '## hidden neighbour' },
    next: { ts: '1790000002.000001', user: 'U2SSALICE', text: 'right after' },
    next_2: { ts: '1790000002.000002', user: 'U2SSALICE', text: 'from elsewhere', channel: 'C0OTHER' },
  }),
  match('02', PRIV, 'private plan'),
  match('03', PUB2, '## hidden hit'),
  match('04', PUB2, 'a reply', { permalink: `https://fixture.slack.com/archives/${PUB2}/p1790000004000100?thread_ts=1790000003.000100` }),
];

let searchCalls: { query: string; sort: string; sortDir: string }[] = [];
let busyQueries = new Set<string>();
let slowQuery = '';
const removers = [
  addFakeHandler(async (method, args) => {
    if (method === 'conversations.info' && [PUB, PUB2, PRIV].includes(String(args.channel))) {
      return { ok: true, channel: { id: args.channel, name: args.channel === PUB ? 'ship' : 'lounge', is_channel: true, is_private: args.channel === PRIV } };
    }
    if (method !== 'search.messages' || !String(args.query).startsWith(`ss${r}`)) return undefined;
    const q = String(args.query);
    searchCalls.push({ query: q, sort: String(args.sort), sortDir: String(args.sort_dir) });
    if (busyQueries.has(q)) throw new SlackBusyError('slack:rl:user:search.messages', 42_000);
    if (q === slowQuery) await new Promise((res) => setTimeout(res, 150));
    return { ok: true, messages: { total: 999, matches: MATCHES } };
  }),
];
const q = (s: string) => `ss${r} ${s}`;

afterAll(async () => {
  for (const rm of removers) rm();
  await sql.end();
});

describe('slimMatch', () => {
  it('keeps exactly what the tool shows: same rendering, no extra fields, no `##` or foreign context', async () => {
    const full = [MATCHES[0], MATCHES[3]];
    const slim = full.map(slimMatch);
    const names = await getUserNames(searchUserIds(full));
    expect(formatSearchMatches(slim, names).text).toBe(formatSearchMatches(full, names).text);
    expect(searchUserIds(slim).sort()).toEqual(searchUserIds(full).sort());
    const json = JSON.stringify(slim);
    for (const gone of ['hidden neighbour', 'from elsewhere', 'blocks', 'iid', 'team', 'is_private']) expect(json).not.toContain(gone);
    expect(json).toContain('forwarded body');
  });
});

describe('slack_search cache', () => {
  it('serves an identical search from the cache; a different sort is a different search', async () => {
    searchCalls = [];
    const tool = toolsFor('child', ctx()).slack_search;
    const first: string = await exec(tool, { query: q('plan') });
    expect(first).toContain('(2 shown, public channels only)');
    expect(first).not.toMatch(/private plan|hidden|999/);
    const again: string = await exec(toolsFor('front', ctx()).slack_search, { query: q('plan') });
    expect(again).toBe(first);
    expect(searchCalls).toHaveLength(1);
    await exec(tool, { query: q('plan'), sort: 'oldest' });
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[1]).toMatchObject({ sort: 'timestamp', sortDir: 'asc' });
    // Stored: only the public, slimmed matches, with a short TTL.
    const key = searchCacheKey(q('plan'), undefined);
    const stored = JSON.parse((await redis.get(key))!);
    expect(stored.map((m: any) => m.channel.id)).toEqual([PUB, PUB2]);
    expect(JSON.stringify(stored)).not.toMatch(/private plan|hidden/);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(limits.slackSearchCacheTtlS);
  });

  it('re-checks cached matches against channel visibility (a channel that went private drops out)', async () => {
    searchCalls = [];
    await exec(toolsFor('child', ctx()).slack_search, { query: q('visibility') });
    await redis.set(`slack:chanvis:${PUB2}`, 'private', 'EX', 60);
    try {
      const out: string = await exec(toolsFor('child', ctx()).slack_search, { query: q('visibility') });
      expect(searchCalls).toHaveLength(1);
      expect(out).toContain('(1 shown, public channels only)');
      expect(out).not.toContain(PUB2);
    } finally {
      await redis.del(`slack:chanvis:${PUB2}`);
    }
  });

  it('concurrent identical searches share one Slack call', async () => {
    searchCalls = [];
    slowQuery = q('concurrent');
    const tools = [0, 1, 2].map(() => toolsFor('child', ctx()).slack_search);
    const outs: string[] = await Promise.all(tools.map((t) => exec(t, { query: q('concurrent') })));
    expect(searchCalls).toHaveLength(1);
    expect(new Set(outs).size).toBe(1);
  });
});

describe('slack_search busy + budget', () => {
  it('a full rate limiter gives a model-facing busy result (not an error), and nothing is cached', async () => {
    busyQueries.add(q('busy'));
    const out: string = await exec(toolsFor('child', ctx()).slack_search, { query: q('busy') });
    expect(out).toBe(searchBusyText(42_000));
    expect(out).toContain('~42s until a slot frees');
    expect(out).toMatch(/ask_thread \/ read_public_thread \/ read_public_channel/);
    expect(await redis.exists(searchCacheKey(q('busy'), undefined))).toBe(0);
  });

  it('after the soft budget, results in a subagent run carry an advisory note; the searches still run', async () => {
    const tool = toolsFor('child', ctx()).slack_search;
    const budget = limits.slackSearchSoftBudgetPerRun;
    for (let i = 1; i <= budget; i++) expect(await exec(tool, { query: q(`budget ${i}`) })).not.toContain('[Note:');
    const over: string = await exec(tool, { query: q('budget over') });
    expect(over).toContain('(2 shown, public channels only)');
    expect(over).toContain(`that's ${budget + 1} searches in this run`);
    // Front-agent turns don't get the note.
    const front = toolsFor('front', ctx()).slack_search;
    for (let i = 1; i <= budget + 1; i++) expect(await exec(front, { query: q(`budget ${i}`) })).not.toContain('[Note:');
  });

  it('searchBudgetNote / searchBusyText', () => {
    expect(searchBudgetNote(3, 12)).toBeNull();
    expect(searchBudgetNote(12, 12)).toBeNull();
    expect(searchBudgetNote(13, 12)).toMatch(/13 searches in this run/);
    expect(searchBusyText(200)).toContain('~1s');
  });
});
