/**
 * search_past_conversations against real Postgres + Redis (Slack lookups mocked): which threads are found and shown.
 *   LIVE=1 pnpm vitest run src/tools/past-conversations.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const LIVE = process.env.LIVE === '1';
if (LIVE) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  process.env.SLACK_FAKE = '1';
  process.env.LOG_LEVEL ??= 'warn';
}

const kinds: Record<string, string> = { C_PAST_PUB: 'public_channel', C_PAST_HERE: 'public_channel', G_PAST_PRIV: 'private_channel', D_PAST_DM: 'dm' };
vi.mock('../context/conversation.js', async (orig) => ({
  ...(await orig<typeof import('../context/conversation.js')>()),
  getConversationInfo: async (id: string) => (kinds[id] ? { id, name: id.toLowerCase(), kind: kinds[id], isExtShared: false, isMember: true, imUserId: id === 'D_PAST_DM' ? 'U_PAST' : undefined } : null),
  isChannelMember: async () => true,
}));
vi.mock('./slack-search.js', async (orig) => ({
  ...(await orig<typeof import('./slack-search.js')>()),
  publicChannelIds: async (ids: string[]) => new Set(ids.filter((id) => kinds[id] === 'public_channel')),
}));

describe.skipIf(!LIVE)('search_past_conversations (DB)', () => {
  let sql: typeof import('../db/index.js').sql;
  let mod: typeof import('./past-conversations.js');
  const user = 'U_PAST';
  const base = Math.floor(Date.now() / 1000);
  const threads = [
    { channel: 'C_PAST_PUB', ts: `${base - 300}.000100`, text: 'make a cheese version of the wemighthavewon emoji', isDm: false },
    { channel: 'G_PAST_PRIV', ts: `${base - 200}.000100`, text: 'the cheese plan for the private channel', isDm: false },
    { channel: 'D_PAST_DM', ts: `${base - 100}.000100`, text: 'secret cheese thoughts in my DM', isDm: true },
  ];
  const here = { channel: 'C_PAST_HERE', ts: `${base}.000100` };

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    mod = await import('./past-conversations.js');
    for (const t of [...threads, { ...here, text: 'what was that cheese thing?', isDm: false }]) {
      const id = `${t.channel}:${t.ts}`;
      await sql`delete from threads where id = ${id}`;
      await sql`insert into threads (id, channel_id, thread_ts, is_dm) values (${id}, ${t.channel}, ${t.ts}, ${t.isDm})`;
      await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${t.channel}, ${t.ts}, ${id}, ${user}, ${t.text})`;
      await sql`insert into turns (thread_id, author_id, status, message_ts) values (${id}, ${user}, 'done', ${[t.ts]})`;
    }
    // Someone else's thread mentioning cheese: never found (the speaker didn't talk to the bot there).
    const other = `C_PAST_PUB:${base - 50}.000100`;
    await sql`delete from threads where id = ${other}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${other}, 'C_PAST_PUB', ${`${base - 50}.000100`})`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values ('C_PAST_PUB', ${`${base - 50}.000100`}, ${other}, 'U_OTHER', 'cheese for everyone')`;
    await sql`insert into turns (thread_id, author_id, status, message_ts) values (${other}, 'U_OTHER', 'done', ${[`${base - 50}.000100`]})`;
  });

  afterAll(async () => {
    await sql`delete from threads where channel_id in ('C_PAST_PUB', 'G_PAST_PRIV', 'D_PAST_DM', 'C_PAST_HERE')`;
  });

  const search = async (channel: string, ts: string, query: string | null) => {
    const t = mod.searchPastConversationsTool({ role: 'front', threadId: `${channel}:${ts}`, channelId: channel, threadTs: ts, speakerId: user, extras: {} });
    return String(await t.execute!({ query }, { toolCallId: 'x', messages: [] }));
  };

  it('shows only public threads in a public channel, and says some were withheld', async () => {
    const out = await search(here.channel, here.ts, 'cheese emoji');
    expect(out).toContain('wemighthavewon');
    expect(out).not.toMatch(/private channel|secret cheese|cheese for everyone/);
    expect(out).toMatch(/2 matching threads are in conversations that can.t be shown here/);
    expect(out).toContain(`https://slack.com/archives/C_PAST_PUB/p${threads[0]!.ts.replace('.', '')}`);
  });

  it("shows private channels in the speaker's own DM", async () => {
    const out = await search('D_PAST_DM', `${base + 10}.000100`, 'cheese');
    expect(out).toContain('the cheese plan for the private channel');
    expect(out).toContain('secret cheese thoughts'); // the same DM, older thread
    expect(out).toContain('wemighthavewon');
  });

  it('lists recent conversations without a query', async () => {
    const out = await search(here.channel, here.ts, null);
    expect(out).toContain('wemighthavewon');
    expect(out).not.toContain('secret cheese');
  });
});
