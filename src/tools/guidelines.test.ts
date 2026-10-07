/**
 * Guidelines + privacy in the tools the agent reads Slack with: `##` messages are invisible to read_thread /
 * read_channel / slack_search, and slack_search only ever shows verified public channels.
 */
import './test-env.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler, fakeSlackError } from '../core/slack-fake.js';
import { threadIdOf } from '../core/events.js';
import { toolsFor, type ToolContext } from '../core/tools.js';
import './index.js';
import { filterPublicMatches, isPublicChannelInfo, isPublicChannelMatch } from './slack-search.js';
import { forgetChannelVisibility } from './test-visibility.js';

const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const rootTs = '1790000000.000100';
const threadId = threadIdOf(channel, rootTs);
const removers: (() => void)[] = [];
const ctx = (): Omit<ToolContext, 'role'> => ({ threadId, channelId: channel, threadTs: rootTs, speakerId: 'U0GUIDE', turnId: 1, extras: {} });
const exec = (t: any, input: any) => t.execute(input, { toolCallId: 'tc1', messages: [] });

// Channel visibility as conversations.info reports it. Unknown ids → channel_not_found (private, bot not a member).
const INFO: Record<string, any> = {
  C0PUBA: { id: 'C0PUBA', name: 'ship', is_channel: true, is_private: false },
  C0PUBB: { id: 'C0PUBB', name: 'lounge', is_channel: true, is_private: false },
  C0NEWPRIV: { id: 'C0NEWPRIV', name: 'staff', is_channel: true, is_private: true },
  C0FLAKY: 'error',
};
let infoCalls: string[] = [];

removers.push(
  addFakeHandler((method, args) => {
    if (method === 'conversations.info' && String(args.channel).startsWith('C0') && args.channel !== channel) {
      const id = String(args.channel);
      infoCalls.push(id);
      const info = INFO[id];
      if (info === 'error') throw fakeSlackError('internal_error');
      if (!info) throw fakeSlackError('channel_not_found');
      return { ok: true, channel: info };
    }
    if (args.channel !== channel) return undefined;
    if (method === 'conversations.replies') {
      return {
        ok: true,
        has_more: false,
        messages: [
          { type: 'message', user: 'U1', text: 'root question', ts: rootTs, thread_ts: rootTs },
          { type: 'message', user: 'U2', text: 'visible reply', ts: '1790000000.000200', thread_ts: rootTs },
          { type: 'message', user: 'U2', text: '## hidden aside', ts: '1790000000.000300', thread_ts: rootTs },
        ],
      };
    }
    if (method === 'conversations.history') {
      return {
        ok: true,
        has_more: false,
        messages: [
          { type: 'message', user: 'U3', text: ' ## hidden channel note', ts: '1789999999.000200' },
          { type: 'message', user: 'U3', text: 'visible channel note', ts: '1789999999.000100' },
        ],
      };
    }
    return undefined;
  }),
);

const match = (id: string, ch: any, text = `result in ${ch.id}`) => ({
  iid: id,
  channel: ch,
  type: 'message',
  user: 'U0GSRCH', // not a fixture user: names are cached across test files
  username: 'bob',
  ts: `17900000${id}.000100`,
  text,
  permalink: `https://fixture.slack.com/archives/${ch.id}/p17900000${id}000100`,
  previous: { user: 'U0X', text: `context near ${ch.id}`, ts: '1.1' },
  next: { user: 'U0X', text: '## hidden neighbour', ts: '1.2' },
});
const MATCHES = [
  match('01', { id: 'C0PUBA', name: 'ship', is_channel: true, is_private: false }),
  match('02', { id: 'C0NEWPRIV', name: 'staff' }, 'secret staff talk'), // new-style private channel, no is_private on the match
  match('03', { id: 'C0PRIVFLAG', name: 'flagged', is_private: true }, 'flagged private'),
  match('04', { id: 'G0OLDPRIV', name: 'old-private', is_group: true }, 'old private group'),
  match('05', { id: 'D0DM', name: 'U0INGO', is_im: true }, 'dm text'),
  match('06', { id: 'C0MPIMX', name: 'mpdm-a--b-1', is_mpim: true }, 'mpim text'),
  match('07', { id: 'C0UNKNOWN', name: 'mystery' }, 'unknown channel text'), // info: channel_not_found
  match('08', { id: 'C0FLAKY', name: 'flaky', is_private: false }, 'flaky lookup text'), // info: error → excluded
  match('09', { id: 'C0PUBB', name: 'lounge' }), // public per info even without the flag
  match('10', { id: 'C0PUBA', name: 'ship', is_private: false }, '## hidden search hit'),
];
removers.push(addFakeHandler((method, args) => (method === 'search.messages' && args.query === 'guidelines' ? { ok: true, messages: { total: 2345, matches: MATCHES } } : undefined)));

beforeEach(async () => {
  infoCalls = [];
  await forgetChannelVisibility('C0*');
});

afterAll(async () => {
  removers.forEach((r) => r());
  await sql`delete from threads where channel_id = ${channel}`;
  await sql`delete from messages where channel_id = ${channel}`;
  await sql.end();
});

describe('## messages are invisible to read tools', () => {
  it('read_thread', async () => {
    const out: string = await exec(toolsFor('front', ctx()).read_thread, {});
    expect(out).toContain('visible reply');
    expect(out).toContain('root question');
    expect(out).not.toContain('hidden');
  });
  it('read_channel', async () => {
    const out: string = await exec(toolsFor('child', ctx()).read_channel, {});
    expect(out).toContain('visible channel note');
    expect(out).not.toContain('hidden');
  });
});

describe('slack_search privacy', () => {
  it('match flags: fail closed', () => {
    expect(isPublicChannelMatch(MATCHES[0])).toBe(true);
    expect(isPublicChannelMatch(MATCHES[1])).toBe(true); // ambiguous: needs conversations.info
    expect(isPublicChannelMatch(MATCHES[2])).toBe(false);
    expect(isPublicChannelMatch(MATCHES[3])).toBe(false);
    expect(isPublicChannelMatch(MATCHES[4])).toBe(false);
    expect(isPublicChannelMatch(MATCHES[5])).toBe(false);
    expect(isPublicChannelMatch({ channel: { id: 'C1', is_private: 'no' } })).toBe(false);
    expect(isPublicChannelMatch({})).toBe(false);
    expect(isPublicChannelInfo({ id: 'C1', is_private: false })).toBe(true);
    expect(isPublicChannelInfo({ id: 'C1' })).toBe(false); // is_private missing → not public
    expect(isPublicChannelInfo({ id: 'C1', is_private: false, is_mpim: true })).toBe(false);
  });

  it('only verified public channels survive; private C-ids, unknown and failed lookups are excluded', async () => {
    const out = await filterPublicMatches(MATCHES);
    expect(out.map((m) => m.channel.id)).toEqual(['C0PUBA', 'C0PUBB']);
    // Lookups only for candidates; cached afterwards (the failed one is retried).
    expect(new Set(infoCalls)).toEqual(new Set(['C0PUBA', 'C0NEWPRIV', 'C0UNKNOWN', 'C0FLAKY', 'C0PUBB']));
    infoCalls = [];
    await filterPublicMatches(MATCHES);
    expect(infoCalls).toEqual(['C0FLAKY']);
  });

  it('the tool output never mentions private results or totals; context only from public matches', async () => {
    const out: string = await exec(toolsFor('child', ctx()).slack_search, { query: 'guidelines' });
    expect(out).toContain('(2 shown, public channels only)');
    expect(out).toContain('|ship>');
    expect(out).toContain('|lounge>');
    expect(out).toContain('context near C0PUBA');
    expect(out).toContain('context near C0PUBB');
    for (const leak of ['secret staff', 'staff', 'flagged', 'old private', 'dm text', 'mpim', 'mystery', 'unknown channel', 'flaky', 'C0NEWPRIV', 'C0PRIVFLAG', 'G0OLDPRIV', 'D0DM', 'C0MPIMX', 'C0UNKNOWN', 'C0FLAKY', '2345', 'hidden search hit', 'hidden neighbour']) {
      expect(out).not.toContain(leak);
    }
    const front: string = await exec(toolsFor('front', ctx()).slack_search, { query: 'guidelines' });
    expect(front).toContain('(2 shown, public channels only)');
  });
});
