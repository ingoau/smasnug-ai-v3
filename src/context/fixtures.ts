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
      msg.text = 'long message '.repeat(200);
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
