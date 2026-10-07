/**
 * Realistic Slack API fixtures for tests and SLACK_FAKE dev runs (shapes copied from real conversations.replies /
 * conversations.history / search.messages responses, trimmed). Use with `addFakeHandler(slackFixtureHandler(...))`.
 */
import type { FakeHandler } from '../core/slack-fake.js';

export const FIX_CHANNEL = 'C0FIXTURE1';
export const FIX_THREAD_TS = '1790000000.000100';

const file = (id: string, name: string, mimetype: string) => ({
  id,
  created: 1790000000,
  timestamp: 1790000000,
  name,
  title: name,
  mimetype,
  filetype: name.split('.').pop(),
  user: 'U0INGO',
  mode: 'hosted',
  is_external: false,
  url_private: `https://files.slack.com/files-pri/T0FIX-${id}/${name}`,
  url_private_download: `https://files.slack.com/files-pri/T0FIX-${id}/download/${name}`,
  permalink: `https://fixture.slack.com/files/U0INGO/${id}/${name}`,
});

/** Builds a thread: parent + `replyCount` replies, with files, a bot message, an edit, a join and a tombstone. */
export function fixtureReplies(replyCount = 40, threadTs = FIX_THREAD_TS) {
  const base = Number(threadTs.split('.')[0]);
  const parent: any = {
    client_msg_id: 'a1b2c3',
    type: 'message',
    text: 'Anyone know how to fix the <https://hackclub.com|Hack Club> site build? cc <@U0BOB> &amp; <!here>',
    user: 'U0INGO',
    ts: threadTs,
    team: 'T0FIX',
    thread_ts: threadTs,
    reply_count: replyCount,
    reply_users_count: 3,
    latest_reply: `${base + replyCount}.000100`,
    reply_users: ['U0BOB', 'U0ALICE'],
    is_locked: false,
    subscribed: true,
    files: [file('F0SHOT', 'screenshot.png', 'image/png'), file('F0CSV', 'budget.csv', 'text/csv')],
    upload: false,
    display_as_bot: false,
    reactions: [
      { name: '+1', users: ['U0BOB', 'U0ALICE'], count: 2 },
      { name: 'eyes', users: ['UBOT'], count: 1 },
    ],
  };
  const replies: any[] = [];
  for (let i = 1; i <= replyCount; i++) {
    const ts = `${base + i}.000100`;
    const user = i % 3 === 0 ? 'U0ALICE' : 'U0BOB';
    if (i === 5) {
      replies.push({ type: 'message', subtype: 'tombstone', text: 'This message was deleted.', user: 'USLACKBOT', ts, thread_ts: threadTs, hidden: true });
      continue;
    }
    if (i === 6) {
      replies.push({ type: 'message', subtype: 'channel_join', text: '<@U0NEW> has joined the channel', user: 'U0NEW', ts, thread_ts: threadTs });
      continue;
    }
    if (i === replyCount - 2) {
      replies.push({
        type: 'message',
        subtype: 'bot_message',
        text: 'Build #42 failed :x:',
        bot_id: 'B0CI',
        username: 'CI Bot',
        bot_profile: { id: 'B0CI', name: 'CI Bot', app_id: 'A0CI' },
        ts,
        thread_ts: threadTs,
      });
      continue;
    }
    const msg: any = { client_msg_id: `m${i}`, type: 'message', text: `reply number ${i}`, user, ts, team: 'T0FIX', thread_ts: threadTs, parent_user_id: 'U0INGO' };
    if (i === replyCount - 1) {
      msg.text = 'here is the error log';
      msg.files = [file('F0HEIC', 'IMG_0042.HEIC', 'image/heic')];
    }
    if (i === replyCount) {
      // ~26k chars: longer than the biggest per-message cut (limits.newMessageTruncateTokens * 4 = 16k), so it's
      // truncated wherever it renders. (No config import here: format.test.ts loads this without env.)
      msg.text = 'long message '.repeat(2000);
      msg.edited = { user, ts: `${base + i + 5}.000000` };
    }
    replies.push(msg);
  }
  return { ok: true, messages: [parent, ...replies], has_more: false, response_metadata: { next_cursor: '' } };
}

export function fixtureHistory(threadTs = FIX_THREAD_TS) {
  const base = Number(threadTs.split('.')[0]);
  return [
    { type: 'message', text: 'morning all', user: 'U0ALICE', ts: `${base - 300}.000100` },
    { type: 'message', text: 'deploy went out', user: 'U0BOB', ts: `${base - 200}.000100`, thread_ts: `${base - 200}.000100`, reply_count: 2 },
    { type: 'message', subtype: 'channel_join', text: '<@U0NEW> has joined the channel', user: 'U0NEW', ts: `${base - 150}.000100` },
    { type: 'message', text: 'lunch?', user: 'U0ALICE', ts: `${base - 100}.000100` },
    { type: 'message', text: 'after the parent', user: 'U0BOB', ts: `${base + 50}.000200` },
  ];
}

export const FIX_USERS: Record<string, any> = {
  U0INGO: { id: 'U0INGO', name: 'ingo', real_name: 'Ingo Wolf', tz: 'Europe/Berlin', tz_offset: 7200, is_bot: false, profile: { display_name: 'Ingo', real_name: 'Ingo Wolf', image_192: 'https://avatars.slack-edge.com/ingo_192.png' } },
  U0BOB: { id: 'U0BOB', name: 'bob', real_name: 'Bob Builder', tz: 'America/New_York', tz_offset: -14400, is_bot: false, profile: { display_name: '', real_name: 'Bob Builder', image_192: 'https://avatars.slack-edge.com/bob_192.png' } },
  U0ALICE: { id: 'U0ALICE', name: 'alice', real_name: 'Alice', tz: 'Asia/Kolkata', tz_offset: 19800, is_bot: false, profile: { display_name: 'alice', image_192: 'https://avatars.slack-edge.com/alice_192.png' } },
};

/** A fake handler serving the fixture thread/history/users for FIX_CHANNEL. */
export function slackFixtureHandler(opts: { replyCount?: number; channel?: string; threadTs?: string } = {}): FakeHandler {
  const channel = opts.channel ?? FIX_CHANNEL;
  const threadTs = opts.threadTs ?? FIX_THREAD_TS;
  const replies = fixtureReplies(opts.replyCount ?? 40, threadTs);
  const history = fixtureHistory(threadTs);
  return (method, args) => {
    if (method === 'users.info' && FIX_USERS[String(args.user)]) return { ok: true, user: FIX_USERS[String(args.user)] };
    if (args.channel !== channel) return undefined;
    if (method === 'conversations.replies' && args.ts === threadTs) {
      const latest = args.latest as string | undefined;
      const msgs = latest ? replies.messages.filter((m: any) => m.ts === threadTs || Number(m.ts) < Number(latest)) : replies.messages;
      return { ...replies, messages: msgs };
    }
    if (method === 'conversations.history') {
      const lo = args.oldest ? Number(args.oldest) : -Infinity;
      const hi = args.latest ? Number(args.latest) : Infinity;
      const inRange = history.filter((m) => Number(m.ts) > lo && Number(m.ts) < hi).sort((a, b) => Number(b.ts) - Number(a.ts));
      const limit = Number(args.limit ?? 100);
      return { ok: true, messages: inRange.slice(0, limit), has_more: inRange.length > limit };
    }
    return undefined;
  };
}

/** search.messages response with public, private, DM and MPIM hits (only the public ones may be shown). */
export function fixtureSearch() {
  const match = (id: string, channel: any, text: string, user = 'U0BOB', username = 'bob') => ({
    iid: id,
    team: 'T0FIX',
    channel,
    type: 'message',
    user,
    username,
    ts: `179000${id}.000100`,
    text,
    permalink: `https://fixture.slack.com/archives/${channel.id}/p179000${id}000100`,
  });
  const pub = { id: 'C0PUB', name: 'ship', is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_shared: false, is_org_shared: false, is_ext_shared: false, pending_shared: [], is_pending_ext_shared: false };
  return {
    ok: true,
    query: 'deploy',
    messages: {
      total: 4,
      pagination: { total_count: 4, page: 1, per_page: 20, page_count: 1, first: 1, last: 4 },
      paging: { count: 20, total: 4, page: 1, pages: 1 },
      matches: [
        match('0001', pub, 'the deploy is fixed now, see <https://github.com/hackclub/site|PR>'),
        match('0002', { ...pub, id: 'G0PRIV', name: 'secret-staff', is_channel: false, is_group: true, is_private: true }, 'private deploy talk'),
        match('0003', { id: 'D0DM', name: 'U0INGO', is_channel: false, is_im: true, is_private: true }, 'dm about deploy'),
        match('0004', { id: 'G0MPIM', name: 'mpdm-ingo--bob--alice-1', is_channel: false, is_group: true, is_mpim: true, is_private: true }, 'group dm deploy'),
        match('0005', { ...pub, id: 'C0PUB2', name: 'announcements' }, 'x'.repeat(2000), 'U0ALICE', 'alice'),
      ],
    },
  };
}

/**
 * The Haven Canberra incident (real thread, trimmed): a search hit with dates is a REPLY in a thread whose parent
 * forwards a different game jam (ANU CSSA). Only the thread shows that, and that Haven Canberra is Nov 14-15.
 * The channel is public but the bot isn't in it: conversations.replies works only with the user token.
 */
export const HAVEN = {
  channel: 'C0HAVENBTS',
  channelName: 'haven-canberra-bts',
  rootTs: '1790100000.000100',
  replyTs: '1790100300.000200',
};

export function havenSearchMatches() {
  const ch = { id: HAVEN.channel, name: HAVEN.channelName, is_channel: true, is_private: false, is_im: false, is_mpim: false, is_group: false };
  const link = (ts: string, thread?: string) =>
    `https://fixture.slack.com/archives/${HAVEN.channel}/p${ts.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=${HAVEN.channel}` : ''}`;
  return [
    {
      iid: 'h1',
      team: 'T0FIX',
      channel: ch,
      type: 'message',
      user: 'U0HVNKAI',
      username: 'kai',
      ts: HAVEN.replyTs,
      text: 'Day 1: Friday 2nd October 4:30-8:30pm\nDay 2: Saturday 3rd October 10am-8pm\nDay 3: Sunday 4th October 10am-4pm\nVenue: CSIT building, ANU',
      permalink: link(HAVEN.replyTs, HAVEN.rootTs),
      previous: { type: 'message', user: 'U0HVNMIA', username: 'mia', ts: '1790099000.000100', text: 'has anyone heard back from the venue people?', permalink: link('1790099000.000100') },
      previous_2: { type: 'message', user: 'U0HVNMIA', username: 'mia', ts: '1790098000.000100', text: '## ignore this, testing', permalink: link('1790098000.000100') },
      next: { type: 'message', user: 'U0HVNKAI', username: 'kai', ts: '1790101000.000100', text: 'ok poster draft is in the drive', permalink: link('1790101000.000100') },
    },
    {
      iid: 'h2',
      team: 'T0FIX',
      channel: ch,
      type: 'message',
      user: 'U0HVNMIA',
      username: 'mia',
      ts: '1790090000.000100',
      text: 'kicking off haven canberra bts planning here :tada: budget doc and venue shortlist coming soon',
      permalink: link('1790090000.000100'),
    },
  ];
}

export function havenThread() {
  const base = { type: 'message', team: 'T0FIX', thread_ts: HAVEN.rootTs };
  return [
    {
      ...base,
      user: 'U0HVNMIA',
      ts: HAVEN.rootTs,
      text: 'fwd from the ANU CSSA server: a different jam, not ours. could be a good place to promote haven though',
      reply_count: 4,
      attachments: [
        {
          is_share: true,
          author_name: 'ANU CSSA',
          text: 'ANU CSSA Game Jam 2026 is back! Three days of making games with the ANU Computer Science Students Association. Free food, prizes, all skill levels welcome. Schedule in the thread.',
          fallback: 'ANU CSSA Game Jam 2026 is back!',
        },
      ],
    },
    { ...base, user: 'U0HVNKAI', ts: HAVEN.replyTs, text: havenSearchMatches()[0]!.text },
    { ...base, user: 'U0HVNMIA', ts: '1790100400.000100', text: '## note to self: ask CSSA about sponsors' },
    { ...base, user: 'U0HVNJO', ts: '1790100500.000100', text: 'wait is this haven?? i thought ours was in november' },
    { ...base, user: 'U0HVNMIA', ts: '1790100600.000100', text: 'nope, that schedule is the CSSA jam. Haven Canberra is Saturday 14 - Sunday 15 November, venue still being confirmed' },
  ];
}

export function havenChannelHistory() {
  // Top-level channel messages around the Haven planning thread (## dropped by readers).
  const base = { type: 'message', team: 'T0FIX' };
  return [
    { ...base, user: 'U0HVNMIA', ts: '1790080000.000100', text: 'anyone free to help with haven canberra logistics?' },
    { ...base, user: 'U0HVNKAI', ts: '1790085000.000100', text: '## ignore this channel noise' },
    { ...base, user: 'U0HVNKAI', ts: '1790090000.000100', text: 'kicking off haven canberra bts planning here :tada: budget doc and venue shortlist coming soon' },
    {
      ...base,
      user: 'U0HVNMIA',
      ts: HAVEN.rootTs,
      text: 'fwd from the ANU CSSA server: a different jam, not ours. could be a good place to promote haven though',
      thread_ts: HAVEN.rootTs,
      reply_count: 4,
    },
    { ...base, user: 'U0HVNJO', ts: '1790102000.000100', text: 'poster looks good, shipping to print tomorrow' },
    { ...base, user: 'U0HVNMIA', ts: '1790105000.000100', text: 'venue shortlist updated in the drive' },
    { ...base, user: 'U0HVNKAI', ts: '1790110000.000100', text: 'reminder: haven is mid-november, not the CSSA jam dates' },
  ];
}

/** Fake handler for the Haven scenario: search (any query mentioning haven/canberra/jam), channel info, user-token thread reads. */
export function havenFixtureHandler(opts: { onRepliesCall?: (token: string, args: any) => void; onHistoryCall?: (token: string, args: any) => void } = {}): FakeHandler {
  return (method, args, token) => {
    if (method === 'search.messages' && /haven|canberra|jam|day 1|november|october/i.test(String(args.query))) {
      return { ok: true, query: args.query, messages: { total: 2, matches: havenSearchMatches() } };
    }
    if (args.channel !== HAVEN.channel) return undefined;
    if (method === 'conversations.info') return { ok: true, channel: { id: HAVEN.channel, name: HAVEN.channelName, is_channel: true, is_private: false, is_member: false } };
    if (method === 'conversations.history') {
      opts.onHistoryCall?.(token, args);
      if (token !== 'user') throw Object.assign(new Error('An API error occurred: not_in_channel'), { code: 'slack_webapi_platform_error', data: { ok: false, error: 'not_in_channel' } });
      const all = havenChannelHistory();
      const lo = args.oldest !== undefined ? Number(args.oldest) : -Infinity;
      const hi = args.latest !== undefined ? Number(args.latest) : Infinity;
      const inclusive = args.inclusive === true;
      const inRange = all.filter((m) => {
        const t = Number(m.ts);
        if (inclusive) return t >= lo && t <= hi;
        return t > lo && t < hi;
      });
      // Slack returns newest first.
      const newestFirst = [...inRange].sort((a, b) => Number(b.ts) - Number(a.ts));
      const limit = Number(args.limit ?? 100);
      return { ok: true, messages: newestFirst.slice(0, limit), has_more: newestFirst.length > limit };
    }
    if (method === 'conversations.replies') {
      opts.onRepliesCall?.(token, args);
      // The bot isn't in the channel: only the user token can read it.
      if (token !== 'user') throw Object.assign(new Error('An API error occurred: not_in_channel'), { code: 'slack_webapi_platform_error', data: { ok: false, error: 'not_in_channel' } });
      const all = havenThread();
      if (args.ts === HAVEN.rootTs) return { ok: true, messages: all, has_more: false };
      const one = all.find((m) => m.ts === args.ts);
      return one ? { ok: true, messages: [one], has_more: false } : { ok: true, messages: [], has_more: false };
    }
    return undefined;
  };
}
