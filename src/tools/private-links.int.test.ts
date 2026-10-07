/**
 * Private-channel links through read_public_thread / read_public_channel / ask_thread, against the fake Slack and
 * the test Postgres/Redis (TEST_DATABASE_URL / TEST_REDIS_URL; see src/testing/):
 *   INTEGRATION=1 pnpm vitest run src/tools/private-links
 * Readable only when the bot and the speaker are both in the private channel and the request is made in the
 * speaker's DM with the bot (or in that channel); everything else gets a refusal that leaks nothing.
 */
import './test-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';

const h = vi.hoisted(() => ({ prompts: [] as any[] }));
vi.mock('../models.js', async (orig) => {
  const { MockLanguageModelV4 } = await import('ai/test');
  return {
    ...(await orig<typeof import('../models.js')>()),
    chatModel: () =>
      new MockLanguageModelV4({
        doGenerate: async (opts: any) => {
          h.prompts.push(opts.prompt);
          return {
            content: [{ type: 'text', text: 'The launch moved to Friday [1790000001.000100].' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
            warnings: [],
          } as any;
        },
      }),
  };
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('private-channel links', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let toolsFor: typeof import('../core/tools.js').toolsFor;
  let PL: typeof import('./private-links.js');
  const removers: (() => void)[] = [];

  const r = rand();
  const SPEAKER = `U0PLS${r}`;
  const OUTSIDER = `U0PLO${r}`;
  const PRIV = `C0PLPRIV${r}`; // private, bot + speaker are members
  const NOBOT = `C0PLNOBOT${r}`; // private, speaker is a member, the bot isn't
  const GONE = `C0PLGONE${r}`; // invisible to the bot (Slack: channel_not_found)
  const OTHERPRIV = `C0PLOTHER${r}`; // another private channel the bot is in
  const PUB = `C0PLPUB${r}`;
  const MPIM = `C0PLMPIM${r}`;
  const DM = `D0PLS${r}`; // the speaker's DM with the bot
  const ODM = `D0PLO${r}`; // the outsider's DM with the bot
  const NAME = 'launch-secret-staff';
  const ROOT = '1790000000.000100';
  const link = (ch: string, ts = ROOT) => `https://x.slack.com/archives/${ch}/p${ts.replace('.', '')}`;

  const msgs = (ch: string) => [
    { type: 'message', user: SPEAKER, text: 'when is the launch?', ts: ROOT, thread_ts: ROOT, reply_count: 2 },
    { type: 'message', user: 'U0PLKAI', text: `moved to friday (${ch})`, ts: '1790000001.000100', thread_ts: ROOT },
    { type: 'message', user: 'U0PLKAI', text: '## invisible aside', ts: '1790000002.000100', thread_ts: ROOT },
  ];
  const reads: { method: string; channel: string; token: string }[] = [];

  const ctx = (channelId: string, speakerId = SPEAKER) => ({ threadId: `${channelId}:${ROOT}`, channelId, threadTs: ROOT, speakerId, turnId: 1, extras: {} });
  const exec = (tool: string, c: ReturnType<typeof ctx>, input: any, role: 'front' | 'child' = 'front') =>
    (toolsFor(role, c) as any)[tool].execute(input, { toolCallId: 'tc1', messages: [] }) as Promise<string>;

  beforeAll(async () => {
    sql = (await import('../db/index.js')).sql;
    redis = (await import('../core/redis.js')).redis;
    toolsFor = (await import('../core/tools.js')).toolsFor;
    const { addFakeHandler, fakeSlackError } = await import('../core/slack-fake.js');
    await import('./index.js');
    PL = await import('./private-links.js');

    const info: Record<string, any> = {
      [PRIV]: { id: PRIV, name: NAME, is_channel: true, is_private: true, is_member: true },
      [NOBOT]: { id: NOBOT, name: 'nobot-secret', is_channel: true, is_private: true, is_member: false },
      [OTHERPRIV]: { id: OTHERPRIV, name: 'other-private', is_channel: true, is_private: true, is_member: true },
      [PUB]: { id: PUB, name: 'general-pl', is_channel: true, is_private: false, is_member: true },
      [MPIM]: { id: MPIM, name: 'mpdm-a--b--c-1', is_mpim: true, is_private: true, is_member: true },
      [DM]: { id: DM, is_im: true, user: SPEAKER },
      [ODM]: { id: ODM, is_im: true, user: OUTSIDER },
    };
    const members: Record<string, string[]> = { [PRIV]: [SPEAKER, 'UBOT', 'U0PLKAI'], [NOBOT]: [SPEAKER, 'U0PLKAI'], [OTHERPRIV]: [SPEAKER, 'UBOT'] };
    removers.push(
      addFakeHandler((method, args, token) => {
        const ch = String(args.channel ?? '');
        if (!ch.includes('0PL')) return undefined;
        if (method === 'conversations.info') {
          if (!info[ch]) throw fakeSlackError('channel_not_found');
          return { ok: true, channel: info[ch] };
        }
        if (method === 'conversations.members') {
          if (!members[ch]) throw fakeSlackError('channel_not_found');
          return { ok: true, members: members[ch], response_metadata: { next_cursor: '' } };
        }
        if (method === 'conversations.replies' || method === 'conversations.history') {
          reads.push({ method, channel: ch, token });
          // Like Slack: the bot token can't read a channel it isn't in.
          if (token === 'bot' && !(members[ch] ?? []).includes('UBOT')) throw fakeSlackError('channel_not_found');
          if (method === 'conversations.replies') return { ok: true, has_more: false, messages: msgs(ch) };
          const lo = args.oldest ? Number(args.oldest) : -Infinity;
          const hi = args.latest ? Number(args.latest) : Infinity;
          const inc = args.inclusive === true;
          const top = [{ type: 'message', user: SPEAKER, text: `channel post in ${ch}`, ts: ROOT }, { type: 'message', user: 'U0PLKAI', text: '## hidden post', ts: '1790000005.000100' }];
          return { ok: true, has_more: false, messages: top.filter((m) => (inc ? Number(m.ts) >= lo && Number(m.ts) <= hi : Number(m.ts) > lo && Number(m.ts) < hi)).reverse() };
        }
        return undefined;
      }),
    );
  });

  beforeEach(async () => {
    reads.length = 0;
    h.prompts.length = 0;
    const keys = [...(await redis.keys('slack:conv:v1:*0PL*')), ...(await redis.keys('slack:members:v1:*0PL*'))];
    if (keys.length) await redis.del(...keys);
    await (await import('./test-visibility.js')).forgetChannelVisibility('*0PL*');
  });

  afterAll(async () => {
    removers.forEach((f) => f());
    if (sql) {
      await sql`delete from usage where user_id in (${SPEAKER}, ${OUTSIDER})`;
      await sql.end();
    }
    redis?.disconnect();
  });

  describe('allowed: the speaker’s DM with the bot, both members', () => {
    it('read_public_thread reads it with the bot token, ## dropped', async () => {
      const out = await exec('read_public_thread', ctx(DM), { permalink: link(PRIV) });
      expect(out).toContain(`moved to friday (${PRIV})`);
      expect(out).toContain(`<#${PRIV}|${NAME}>`);
      expect(out).toContain('source="slack thread (private channel)"');
      expect(out).not.toContain('invisible aside');
      expect(reads.map((x) => [x.method, x.token])).toEqual([['conversations.replies', 'bot']]);
    });

    it('ask_thread answers from it (children too)', async () => {
      const out = await exec('ask_thread', ctx(DM), { question: 'When is the launch?', permalink: link(PRIV, '1790000001.000100') + `?thread_ts=${ROOT}` }, 'child');
      expect(out).toContain('The launch moved to Friday');
      expect(JSON.stringify(h.prompts.at(-1))).toContain(`moved to friday (${PRIV})`);
      expect(JSON.stringify(h.prompts.at(-1))).not.toContain('invisible aside');
      expect(new Set(reads.map((x) => x.token))).toEqual(new Set(['bot']));
    });

    it('read_public_channel reads it with the bot token, ## dropped', async () => {
      const out = await exec('read_public_channel', ctx(DM), { permalink: link(PRIV) });
      expect(out).toContain(`channel post in ${PRIV}`);
      expect(out).toContain('source="slack channel (private)"');
      expect(out).not.toContain('hidden post');
      expect(reads.length).toBeGreaterThan(0);
      expect(new Set(reads.map((x) => x.token))).toEqual(new Set(['bot']));
    });

    it('also in the linked private channel itself', async () => {
      expect(await exec('read_public_thread', ctx(PRIV), { permalink: link(PRIV) })).toContain(`moved to friday (${PRIV})`);
    });
  });

  describe('refused', () => {
    const tools: [string, any][] = [
      ['read_public_thread', (ch: string) => ({ permalink: link(ch) })],
      ['read_public_channel', (ch: string) => ({ permalink: link(ch) })],
      ['ask_thread', (ch: string) => ({ question: 'When is the launch?', permalink: link(ch) })],
    ];
    const what = (tool: string) => (tool === 'read_public_channel' ? 'channel' : 'thread');
    const noLeak = (out: string) => {
      for (const s of [NAME, 'nobot-secret', 'moved to friday', 'channel post', 'launch moved']) expect(out).not.toContain(s);
    };

    it.each(tools)('%s in a public channel, even with both members: ask in a DM', async (tool, input) => {
      const out = await exec(tool, ctx(PUB), input(PRIV));
      expect(out).toBe(PL.askInDmMessage(what(tool)));
      noLeak(out);
      expect(reads).toEqual([]);
      expect(h.prompts).toEqual([]);
    });

    it.each(tools)('%s in a group DM or another private channel: ask in a DM', async (tool, input) => {
      for (const where of [MPIM, OTHERPRIV]) expect(await exec(tool, ctx(where), input(PRIV))).toBe(PL.askInDmMessage(what(tool)));
      expect(reads).toEqual([]);
    });

    it.each(tools)('%s when the speaker is not a member: the same answer as a channel that does not exist', async (tool, input) => {
      const outsider = await exec(tool, ctx(ODM, OUTSIDER), input(PRIV));
      const missing = await exec(tool, ctx(DM), input(GONE));
      expect(outsider).toBe(PL.notVisibleMessage(what(tool)));
      expect(outsider).toBe(missing);
      noLeak(outsider);
      expect(reads).toEqual([]);
      expect(h.prompts).toEqual([]);
    });

    it.each(tools)('%s when the bot is not a member: it can’t see the channel', async (tool, input) => {
      const out = await exec(tool, ctx(DM), input(NOBOT));
      expect(out).toBe(PL.notVisibleMessage(what(tool)));
      noLeak(out);
      expect(reads).toEqual([]);
    });

    it('DM links and group DMs are never read, even by their members', async () => {
      for (const ch of [DM, ODM, MPIM]) expect(await exec('read_public_thread', ctx(DM), { permalink: link(ch) })).toBe(PL.notVisibleMessage('thread'));
      expect(await exec('read_public_thread', ctx(MPIM), { permalink: link(MPIM) })).toBe(PL.notVisibleMessage('thread'));
      expect(reads).toEqual([]);
    });
  });

  it('public channels still read with the user token', async () => {
    const out = await exec('read_public_thread', ctx(DM), { permalink: link(PUB) });
    expect(out).toContain('source="slack thread (public channel)"');
    expect(reads.map((x) => x.token)).toEqual(['user']);
  });
});
