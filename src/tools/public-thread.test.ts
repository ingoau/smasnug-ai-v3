/**
 * Search context + read_public_thread (the Haven Canberra incident): search hits show nearby messages and mark
 * thread replies; read_public_thread opens any thread in a verified public channel with the user token.
 */
import './test-env.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler, fakeSlackError } from '../core/slack-fake.js';
import { threadIdOf } from '../core/events.js';
import { toolsFor, type ToolContext } from '../core/tools.js';
import { HAVEN, havenFixtureHandler, havenSearchMatches } from '../context/fixtures.js';
import './index.js';
import { formatSearchMatch, formatSearchMatches, matchContext, matchThreadTs } from './slack-search.js';
import { MISSING_SCOPE_MESSAGE, resolveThreadTarget, selectWindow } from './public-thread.js';
import { parseChannelId, parseSlackPermalink, textWithAttachments } from './util.js';
import { forgetChannelVisibility } from './test-visibility.js';

const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadTs = '1790000000.000100';
const speaker = `U0PT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ctx = (): Omit<ToolContext, 'role'> => ({ threadId: threadIdOf(channel, threadTs), channelId: channel, threadTs, speakerId: speaker, turnId: 1, extras: {} });
const exec = (t: any, input: any) => t.execute(input, { toolCallId: 'tc1', messages: [] });

const repliesCalls: { token: string; args: any }[] = [];
let scopeError: string | null = null;
const removers: (() => void)[] = [];
removers.push(
  addFakeHandler((method, args) => {
    if (method === 'conversations.replies' && args.channel === HAVEN.channel && scopeError) throw fakeSlackError(scopeError);
    // Other channels used below: one private, one unknown to the bot, one public with nothing special.
    if (method === 'conversations.info' && args.channel === 'C0PTPRIV') return { ok: true, channel: { id: 'C0PTPRIV', name: 'staff', is_channel: true, is_private: true } };
    if (method === 'conversations.info' && args.channel === 'C0PTGONE') throw fakeSlackError('channel_not_found');
    if (method === 'conversations.replies' && (args.channel === 'C0PTPRIV' || args.channel === 'C0PTGONE')) {
      repliesCalls.push({ token: 'leak', args });
      return { ok: true, messages: [{ type: 'message', user: 'U1', ts: String(args.ts), text: 'private stuff' }] };
    }
    return undefined;
  }),
);
removers.push(addFakeHandler(havenFixtureHandler({ onRepliesCall: (token, args) => repliesCalls.push({ token, args }) })));

beforeEach(async () => {
  repliesCalls.length = 0;
  scopeError = null;
  await forgetChannelVisibility('C0*');
});

afterAll(async () => {
  removers.forEach((r) => r());
  await sql`delete from usage where user_id = ${speaker}`;
  await sql`delete from threads where channel_id = ${channel}`;
  await sql.end();
});

describe('helpers', () => {
  it('parses permalinks with and without thread_ts', () => {
    expect(parseSlackPermalink('https://hackclub.slack.com/archives/C0HAVENBTS/p1790100300000200?thread_ts=1790100000.000100&cid=C0HAVENBTS')).toEqual({
      channel: 'C0HAVENBTS',
      ts: '1790100300.000200',
      threadTs: '1790100000.000100',
    });
    expect(parseSlackPermalink('https://hackclub.slack.com/archives/C0HAVENBTS/p1790100000000100')).toEqual({ channel: 'C0HAVENBTS', ts: '1790100000.000100' });
    // thread_ts equal to the message itself = the parent: no thread marker
    expect(parseSlackPermalink('https://x.slack.com/archives/C1AB/p1790100000000100?thread_ts=1790100000.000100')).toEqual({ channel: 'C1AB', ts: '1790100000.000100' });
    expect(parseSlackPermalink('<https://x.slack.com/archives/C1AB/p1790100000000100>')?.ts).toBe('1790100000.000100');
    for (const bad of ['', 'not a url', 'https://x.slack.com/archives/C1AB', 'https://x.slack.com/files/U1/F1/a.png', 'ftp://x.slack.com/archives/C1AB/p1790100000000100']) {
      expect(parseSlackPermalink(bad)).toBeUndefined();
    }
    expect(parseChannelId('<#C0HAVENBTS|haven-canberra-bts>')).toBe('C0HAVENBTS');
    expect(parseChannelId('C0HAVENBTS')).toBe('C0HAVENBTS');
    expect(parseChannelId('#haven')).toBeUndefined();
  });

  it('resolves the thread root from a permalink or channel + thread_ts', () => {
    expect(resolveThreadTarget({ permalink: havenSearchMatches()[0]!.permalink })).toEqual({ channel: HAVEN.channel, rootTs: HAVEN.rootTs, linkedTs: HAVEN.replyTs, origin: 'https://fixture.slack.com' });
    expect(resolveThreadTarget({ permalink: `https://x.slack.com/archives/${HAVEN.channel}/p1790100000000100` })).toEqual({ channel: HAVEN.channel, rootTs: HAVEN.rootTs, linkedTs: HAVEN.rootTs, origin: 'https://x.slack.com' });
    expect(resolveThreadTarget({ channel: `<#${HAVEN.channel}|x>`, thread_ts: 'p1790100000000100' })).toEqual({ channel: HAVEN.channel, rootTs: HAVEN.rootTs });
    expect(resolveThreadTarget({ permalink: 'https://example.com' })).toMatchObject({
      error: expect.stringContaining('https://hackclub.slack.com/archives/[channel]/[timestamp]'),
    });
    expect(resolveThreadTarget({ channel: HAVEN.channel })).toHaveProperty('error');
  });

  it('includes forwarded content in message text', () => {
    expect(textWithAttachments({ text: 'fyi', attachments: [{ is_share: true, author_name: 'ANU CSSA', text: 'Game Jam!' }] })).toBe('fyi\n[forwarded from ANU CSSA: Game Jam!]');
    expect(textWithAttachments({ text: 'see Game Jam!', attachments: [{ text: 'Game Jam!' }] })).toBe('see Game Jam!');
    expect(textWithAttachments({ text: 'plain' })).toBe('plain');
  });

  it('windows replies around the linked reply', () => {
    const msgs = Array.from({ length: 101 }, (_, i) => ({ ts: `${1790000000 + i}.000100`, userId: 'U1', botId: null, username: null, text: `m${i}`, files: [] }));
    const root = msgs[0]!.ts;
    const w = selectWindow(msgs, root, 10);
    expect(w.parent?.text).toBe('m0');
    expect(w.slice.map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']);
    expect([w.earlier, w.later, w.total]).toEqual([0, 90, 100]);
    const v = selectWindow(msgs, root, 10, msgs[60]!.ts);
    expect(v.slice.map((m) => m.text)).toContain('m60');
    expect(v.earlier + v.slice.length + v.later).toBe(100);
  });
});

describe('search results: context and thread replies', () => {
  const names = new Map([['U0HVNKAI', 'Kai'], ['U0HVNMIA', 'Mia']]);

  it('shows nearby messages (## dropped) and marks thread replies', () => {
    const [reply, top] = havenSearchMatches();
    expect(matchThreadTs(reply)).toBe(HAVEN.rootTs);
    expect(matchThreadTs(top)).toBeUndefined();
    expect(matchContext(reply).before.map((c) => c.text)).toEqual(['has anyone heard back from the venue people?']);
    const out = formatSearchMatch(reply, 0, names);
    expect(out).toContain(`1. <#${HAVEN.channel}|${HAVEN.channelName}> · <@U0HVNKAI> Kai · ts ${HAVEN.replyTs}`);
    expect(out).toContain(`↳ reply in thread ${HAVEN.rootTs}`);
    expect(out).toContain('read_public_thread');
    expect(out).toContain('nearby before:\n      [1790099000.000100 · 2026-09-22 17:43 UTC] <@U0HVNMIA> Mia: has anyone heard back from the venue people?');
    expect(out).toContain('nearby after:\n      [1790101000.000100 · 2026-09-22 18:16 UTC] <@U0HVNKAI> Kai: ok poster draft is in the drive');
    expect(out).not.toContain('ignore this');
    expect(out).toContain('Day 3: Sunday 4th October');
    expect(formatSearchMatch(top, 1, names)).not.toContain('reply in thread');
  });

  it('drops context that claims another channel', () => {
    const m = { ...havenSearchMatches()[0], next: { ts: '1.2', text: 'from elsewhere', permalink: 'https://x.slack.com/archives/C0OTHER/p1790000000000100' }, next_2: { ts: '1.3', text: 'also elsewhere', channel: { id: 'C0OTHER' } } };
    expect(matchContext(m).after).toEqual([]);
  });

  it('keeps long texts up to ~1200 chars and the whole output bounded', () => {
    const long = { ...havenSearchMatches()[1], text: 'word '.repeat(1000) };
    const one = formatSearchMatch(long, 0, names);
    expect(one).toContain('[truncated]');
    expect(one.length).toBeGreaterThan(1100);
    expect(one.length).toBeLessThan(1500);
    const { text, shown } = formatSearchMatches(Array.from({ length: 10 }, () => long), names, 5000);
    expect(shown).toBe(3);
    expect(text.length).toBeLessThan(5200);
    expect(text).toContain('[7 more results not shown');
  });

  it('the tool shows context for public matches only; private matches stay out entirely', async () => {
    const off = addFakeHandler((method, args) =>
      method === 'search.messages' && args.query === 'mixed'
        ? {
            ok: true,
            messages: {
              total: 99,
              matches: [
                { ...havenSearchMatches()[1], previous: { ts: '1790089000.000100', user: 'U0HVNKAI', text: 'public neighbour' } },
                { ...havenSearchMatches()[1], channel: { id: 'C0PTPRIV', name: 'staff' }, text: 'secret plan', previous: { ts: '1.1', text: 'secret neighbour' }, permalink: 'https://x.slack.com/archives/C0PTPRIV/p1790000000000100' },
              ],
            },
          }
        : undefined,
    );
    try {
      const out: string = await exec(toolsFor('child', ctx()).slack_search, { query: 'mixed' });
      expect(out).toContain('(1 shown, public channels only)');
      expect(out).toContain('public neighbour');
      for (const leak of ['secret', 'staff', 'C0PTPRIV', '99']) expect(out).not.toContain(leak);
    } finally {
      off();
    }
  });
});

describe('read_public_thread', () => {
  it('is available to front and child', () => {
    expect(Object.keys(toolsFor('front', ctx()))).toContain('read_public_thread');
    expect(Object.keys(toolsFor('child', ctx()))).toContain('read_public_thread');
    expect(Object.keys(toolsFor('gate', ctx()))).not.toContain('read_public_thread');
  });

  it('reads the whole thread from a reply permalink with the user token: parent first, ## dropped', async () => {
    const before = (await sql`select count(*)::int as n from usage where user_id = ${speaker} and kind = 'search'`)[0]!.n;
    const out: string = await exec(toolsFor('child', ctx()).read_public_thread, { permalink: havenSearchMatches()[0]!.permalink });
    expect(repliesCalls.map((c) => c.token)).toEqual(['user']);
    expect(repliesCalls[0]!.args).toMatchObject({ channel: HAVEN.channel, ts: HAVEN.rootTs });
    expect(out).toContain('<untrusted_content');
    expect(out).toContain(`Thread in <#${HAVEN.channel}|${HAVEN.channelName}>, root ${HAVEN.rootTs}, 3 replies.`);
    expect(out).toContain(`Slack links look like https://fixture.slack.com/archives/[channel]/[timestamp]`);
    expect(out).toContain(`Example for a reply here: https://fixture.slack.com/archives/${HAVEN.channel}/p<ts digits>?thread_ts=${HAVEN.rootTs}`);
    const parentAt = out.indexOf('Parent:');
    expect(parentAt).toBeGreaterThan(0);
    expect(out.indexOf('[forwarded from ANU CSSA: ANU CSSA Game Jam 2026 is back!')).toBeGreaterThan(parentAt);
    expect(out).toMatch(/\[1790100300\.000200 · 2026-09-22 18:05 UTC\] <@U0HVNKAI> User U0HVNKAI: Day 1: Friday 2nd October[^\n]*\n[^\n]*\n[^\n]*\nVenue: CSIT building, ANU {2}← linked message/);
    expect(out).toContain('Haven Canberra is Saturday 14 - Sunday 15 November');
    expect(out).not.toContain('note to self');
    expect(out.indexOf('Parent:')).toBeLessThan(out.indexOf('Day 1'));
    const after = (await sql`select count(*)::int as n from usage where user_id = ${speaker} and kind = 'search'`)[0]!.n;
    expect(after).toBe(before + 1); // counts toward the Slack search limit
  });

  it('accepts channel + thread_ts, and finds the root from a reply link without thread_ts', async () => {
    const a: string = await exec(toolsFor('front', ctx()).read_public_thread, { channel: HAVEN.channel, thread_ts: HAVEN.rootTs, limit: 1 });
    expect(a).toContain('Parent:');
    expect(a).toContain('Day 1');
    expect(a).toContain('[2 later replies not shown');
    repliesCalls.length = 0;
    const b: string = await exec(toolsFor('front', ctx()).read_public_thread, { permalink: `https://x.slack.com/archives/${HAVEN.channel}/p${HAVEN.replyTs.replace('.', '')}` });
    expect(repliesCalls.map((c) => c.args.ts)).toEqual([HAVEN.replyTs, HAVEN.rootTs]);
    expect(b).toContain('ANU CSSA Game Jam');
    expect(b).toContain('← linked message');
  });

  it('fails closed: private, unknown and non-C channels are refused without reading', async () => {
    for (const input of [
      { channel: 'C0PTPRIV', thread_ts: '1790000000.000100' },
      { permalink: 'https://x.slack.com/archives/C0PTGONE/p1790000000000100' },
      { permalink: 'https://x.slack.com/archives/G0OLDPRIV/p1790000000000100' },
      { permalink: 'https://x.slack.com/archives/D0DM/p1790000000000100' },
    ]) {
      const out: string = await exec(toolsFor('child', ctx()).read_public_thread, input);
      expect(out).toMatch(/^Can't read that thread/);
      expect(out).not.toContain('private stuff');
    }
    expect(repliesCalls).toEqual([]);
  });

  it('explains a missing user scope instead of failing', async () => {
    for (const code of ['missing_scope', 'not_allowed_token_type']) {
      scopeError = code;
      const out: string = await exec(toolsFor('child', ctx()).read_public_thread, { permalink: havenSearchMatches()[0]!.permalink });
      expect(out).toBe(MISSING_SCOPE_MESSAGE);
      expect(out).toContain('channels:history');
    }
  });
});
