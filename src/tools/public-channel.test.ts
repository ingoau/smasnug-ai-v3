/**
 * read_public_channel: fetch a public-channel message by permalink / channel+ts, surrounding context, and
 * paging older/newer through the channel (user token, fail-closed public check).
 */
import './test-env.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler, fakeSlackError } from '../core/slack-fake.js';
import { threadIdOf } from '../core/events.js';
import { toolsFor, type ToolContext } from '../core/tools.js';
import { HAVEN, havenChannelHistory, havenFixtureHandler, havenSearchMatches } from '../context/fixtures.js';
import './index.js';
import { MISSING_SCOPE_MESSAGE, resolveChannelTarget } from './public-channel.js';
import { forgetChannelVisibility } from './test-visibility.js';

const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadTs = '1790000000.000100';
const speaker = `U0PC${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ctx = (): Omit<ToolContext, 'role'> => ({
  threadId: threadIdOf(channel, threadTs),
  channelId: channel,
  threadTs,
  speakerId: speaker,
  turnId: 1,
  extras: {},
});
const exec = (t: any, input: any) => t.execute(input, { toolCallId: 'tc1', messages: [] });

const historyCalls: { token: string; args: any }[] = [];
let scopeError: string | null = null;
const removers: (() => void)[] = [];
removers.push(
  addFakeHandler((method, args) => {
    if (method === 'conversations.history' && args.channel === HAVEN.channel && scopeError) throw fakeSlackError(scopeError);
    if (method === 'conversations.info' && args.channel === 'C0PCPRIV') {
      return { ok: true, channel: { id: 'C0PCPRIV', name: 'staff', is_channel: true, is_private: true } };
    }
    if (method === 'conversations.info' && args.channel === 'C0PCGONE') throw fakeSlackError('channel_not_found');
    if (method === 'conversations.history' && (args.channel === 'C0PCPRIV' || args.channel === 'C0PCGONE')) {
      historyCalls.push({ token: 'leak', args });
      return { ok: true, messages: [{ type: 'message', user: 'U1', ts: '1790000000.000100', text: 'private stuff' }] };
    }
    return undefined;
  }),
);
removers.push(
  addFakeHandler(
    havenFixtureHandler({
      onHistoryCall: (token, args) => historyCalls.push({ token, args }),
    }),
  ),
);

beforeEach(async () => {
  historyCalls.length = 0;
  scopeError = null;
  await forgetChannelVisibility('C0*');
});

afterAll(async () => {
  removers.forEach((r) => r());
  await sql`delete from usage where user_id = ${speaker}`;
  await sql`delete from threads where channel_id = ${channel}`;
  await sql.end();
});

describe('resolveChannelTarget', () => {
  it('resolves permalink, around/before/after, and rejects bad input', () => {
    expect(resolveChannelTarget({ permalink: havenSearchMatches()[1]!.permalink })).toEqual({
      channel: HAVEN.channel,
      mode: 'around',
      ts: '1790090000.000100',
      origin: 'https://fixture.slack.com',
    });
    // Reply permalink → around the parent (channel history has the root, not the reply).
    expect(resolveChannelTarget({ permalink: havenSearchMatches()[0]!.permalink })).toEqual({
      channel: HAVEN.channel,
      mode: 'around',
      ts: HAVEN.rootTs,
      origin: 'https://fixture.slack.com',
      linkedIsReply: true,
      threadTs: HAVEN.rootTs,
    });
    expect(resolveChannelTarget({ channel: `<#${HAVEN.channel}|x>`, around_ts: 'p1790100000000100' })).toEqual({
      channel: HAVEN.channel,
      mode: 'around',
      ts: HAVEN.rootTs,
    });
    expect(resolveChannelTarget({ channel: HAVEN.channel, before_ts: '1790100000.000100' })).toEqual({
      channel: HAVEN.channel,
      mode: 'before',
      ts: '1790100000.000100',
    });
    expect(resolveChannelTarget({ channel: HAVEN.channel, after_ts: '1790100000.000100' })).toEqual({
      channel: HAVEN.channel,
      mode: 'after',
      ts: '1790100000.000100',
    });
    expect(resolveChannelTarget({ channel: HAVEN.channel })).toEqual({ channel: HAVEN.channel, mode: 'latest' });
    expect(resolveChannelTarget({ channel: HAVEN.channel, before_ts: '1790100000.000100', after_ts: '1790110000.000100' })).toHaveProperty('error');
    expect(resolveChannelTarget({ channel: HAVEN.channel, around_ts: '1790100000.000100', before_ts: '1790090000.000100' })).toHaveProperty('error');
    expect(resolveChannelTarget({ permalink: 'https://example.com' })).toMatchObject({
      error: expect.stringContaining('https://hackclub.slack.com/archives/[channel]/[timestamp]'),
    });
    expect(resolveChannelTarget({})).toHaveProperty('error');
  });
});

describe('read_public_channel', () => {
  it('is available to front and child', () => {
    expect(Object.keys(toolsFor('front', ctx()))).toContain('read_public_channel');
    expect(Object.keys(toolsFor('child', ctx()))).toContain('read_public_channel');
    expect(Object.keys(toolsFor('gate', ctx()))).not.toContain('read_public_channel');
  });

  it('reads surrounding context from a top-level permalink with the user token; ## dropped', async () => {
    const before = (await sql`select count(*)::int as n from usage where user_id = ${speaker} and kind = 'search'`)[0]!.n;
    const out: string = await exec(toolsFor('child', ctx()).read_public_channel, {
      permalink: havenSearchMatches()[1]!.permalink,
    });
    expect(historyCalls.length).toBeGreaterThan(0);
    expect(historyCalls.every((c) => c.token === 'user')).toBe(true);
    expect(out).toContain('<untrusted_content');
    expect(out).toContain(`Channel <#${HAVEN.channel}|${HAVEN.channelName}>`);
    expect(out).toContain('kicking off haven canberra bts planning');
    expect(out).toContain('← linked message');
    expect(out).toContain('[thread: 4 replies]');
    expect(out).toContain('Slack links look like https://fixture.slack.com/archives/[channel]/[timestamp]');
    expect(out).not.toContain('ignore this channel noise');
    expect(out).toMatch(new RegExp(`older: read_public_channel channel=${HAVEN.channel} before_ts=\\d+\\.\\d+; newer: read_public_channel channel=${HAVEN.channel} after_ts=\\d+\\.\\d+\\]`));
    const after = (await sql`select count(*)::int as n from usage where user_id = ${speaker} and kind = 'search'`)[0]!.n;
    expect(after).toBe(before + 1);
  });

  it('pages older and newer through the channel', async () => {
    const older: string = await exec(toolsFor('front', ctx()).read_public_channel, {
      channel: HAVEN.channel,
      before_ts: HAVEN.rootTs,
      limit: 10,
    });
    expect(older).toContain('anyone free to help');
    expect(older).toContain('kicking off haven canberra');
    expect(older).not.toContain('venue shortlist updated');
    expect(older).not.toContain('ignore this channel noise');

    const newer: string = await exec(toolsFor('front', ctx()).read_public_channel, {
      channel: HAVEN.channel,
      after_ts: HAVEN.rootTs,
      limit: 10,
    });
    expect(newer).toContain('poster looks good');
    expect(newer).toContain('haven is mid-november');
    expect(newer).not.toContain('anyone free to help');

    const latest: string = await exec(toolsFor('front', ctx()).read_public_channel, {
      channel: HAVEN.channel,
      limit: 3,
    });
    expect(latest).toContain('haven is mid-november');
    expect(latest).toMatch(new RegExp(`\\[3 top-level messages, oldest first, [\\d.]+ to [\\d.]+; older: read_public_channel channel=${HAVEN.channel} before_ts=[\\d.]+; newest message\\]`));
    // Fixture's last three visible messages (## already filtered).
    const visible = havenChannelHistory().filter((m) => !String(m.text).trimStart().startsWith('##'));
    expect(latest).toContain(visible[visible.length - 1]!.text);
  });

  it('accepts channel + around_ts and notes reply permalinks', async () => {
    const around: string = await exec(toolsFor('child', ctx()).read_public_channel, {
      channel: HAVEN.channel,
      around_ts: HAVEN.rootTs,
      limit: 5,
    });
    expect(around).toContain('← linked message');
    expect(around).toContain('fwd from the ANU CSSA');

    const replyLink: string = await exec(toolsFor('child', ctx()).read_public_channel, {
      permalink: havenSearchMatches()[0]!.permalink,
    });
    expect(replyLink).toContain('permalink was a thread reply');
    expect(replyLink).toContain('read_public_thread');
    // Parent is context, not the linked reply — don't mark it as the linked message.
    expect(replyLink).not.toContain('← linked message');
  });

  it('walks newest-first pages so after_ts returns messages right after the cursor in a busy channel', async () => {
    const dense = `C0PCDENSE`;
    const base = 1_790_200_000;
    // 250 messages after the cursor inside the initial 14-day window; Slack returns newest-first.
    const all = Array.from({ length: 250 }, (_, i) => ({
      type: 'message',
      user: 'U0HVNKAI',
      ts: `${base + i + 1}.000100`,
      text: `dense-${i + 1}`,
    }));
    const off = addFakeHandler((method, args) => {
      if (method === 'conversations.info' && args.channel === dense) {
        return { ok: true, channel: { id: dense, name: 'busy', is_channel: true, is_private: false } };
      }
      if (method === 'conversations.history' && args.channel === dense) {
        const lo = args.oldest !== undefined ? Number(args.oldest) : -Infinity;
        const hi = args.latest !== undefined ? Number(args.latest) : Infinity;
        const inclusive = args.inclusive === true;
        const inRange = all.filter((m) => {
          const t = Number(m.ts);
          return inclusive ? t >= lo && t <= hi : t > lo && t < hi;
        });
        const newestFirst = [...inRange].sort((a, b) => Number(b.ts) - Number(a.ts));
        const limit = Number(args.limit ?? 100);
        return { ok: true, messages: newestFirst.slice(0, limit), has_more: newestFirst.length > limit };
      }
      return undefined;
    });
    try {
      await forgetChannelVisibility(dense);
      const out: string = await exec(toolsFor('child', ctx()).read_public_channel, {
        channel: dense,
        after_ts: `${base}.000100`,
        limit: 5,
      });
      expect(out).toContain('dense-1');
      expect(out).toContain('dense-5');
      expect(out).not.toContain('dense-250');
      expect(out).not.toContain('dense-200');
    } finally {
      off();
    }
  });

  it('widens the forward window across quiet gaps when paging after_ts', async () => {
    const gappy = `C0PCGAPPY`;
    const cursor = '1790300000.000100';
    // Next message is ~30 days later (beyond the initial 14-day window).
    const later = { type: 'message', user: 'U0HVNMIA', ts: '1792900000.000100', text: 'after the quiet spell' };
    const off = addFakeHandler((method, args) => {
      if (method === 'conversations.info' && args.channel === gappy) {
        return { ok: true, channel: { id: gappy, name: 'quiet', is_channel: true, is_private: false } };
      }
      if (method === 'conversations.history' && args.channel === gappy) {
        const lo = args.oldest !== undefined ? Number(args.oldest) : -Infinity;
        const hi = args.latest !== undefined ? Number(args.latest) : Infinity;
        const t = Number(later.ts);
        const inRange = t > lo && t < hi ? [later] : [];
        return { ok: true, messages: inRange, has_more: false };
      }
      return undefined;
    });
    try {
      await forgetChannelVisibility(gappy);
      const out: string = await exec(toolsFor('front', ctx()).read_public_channel, {
        channel: gappy,
        after_ts: cursor,
        limit: 5,
      });
      expect(out).toContain('after the quiet spell');
    } finally {
      off();
    }
  });

  it('fails closed: private, unknown and non-C channels are refused without reading', async () => {
    for (const input of [
      { channel: 'C0PCPRIV', around_ts: '1790000000.000100' },
      { permalink: 'https://x.slack.com/archives/C0PCGONE/p1790000000000100' },
      { permalink: 'https://x.slack.com/archives/G0OLDPRIV/p1790000000000100' },
      { permalink: 'https://x.slack.com/archives/D0DM/p1790000000000100' },
    ]) {
      const out: string = await exec(toolsFor('child', ctx()).read_public_channel, input);
      expect(out).toMatch(/^Can't read that channel/);
      expect(out).not.toContain('private stuff');
    }
    expect(historyCalls).toEqual([]);
  });

  it('explains a missing user scope instead of failing', async () => {
    for (const code of ['missing_scope', 'not_allowed_token_type']) {
      scopeError = code;
      const out: string = await exec(toolsFor('child', ctx()).read_public_channel, {
        channel: HAVEN.channel,
        around_ts: HAVEN.rootTs,
      });
      expect(out).toBe(MISSING_SCOPE_MESSAGE);
      expect(out).toContain('channels:history');
    }
  });
});
