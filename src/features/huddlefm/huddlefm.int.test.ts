/**
 * HuddleFM DJ mode against the real Postgres/Redis (test targets) with SLACK_FAKE=1 and a simulated HuddleFM: commands
 * posted into the bot's DM with the HuddleFM user are answered by `fm` below through the real inbound path.
 * Run: INTEGRATION=1 pnpm vitest run src/features/huddlefm/huddlefm.int.test.ts
 */
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.HUDDLEFM_USER_ID = 'UHFM';
});

const generateText = vi.fn();
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText: (...a: unknown[]) => generateText(...a) }));

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const DM = 'DUHFM';

interface Track {
  id: string;
  title: string;
  artist: string;
  automatic?: boolean;
}

/** A tiny HuddleFM: one session, a queue, search over a catalog. */
const fm = {
  channel: '',
  granted: false,
  nowPlaying: null as Track | null,
  queue: [] as Track[],
  catalog: [] as { label: string; reference: string; track: Omit<Track, 'id'> }[],
  /** Next reply for a command type (overrides the default behaviour once). */
  override: new Map<string, Record<string, unknown>>(),
  commands: [] as Record<string, any>[],
  seq: 0,
  reset(channel: string) {
    Object.assign(fm, { channel, granted: false, nowPlaying: null, queue: [], catalog: [], commands: [] });
    fm.override.clear();
  },
  respond(cmd: Record<string, any>): Record<string, unknown> | null {
    fm.commands.push(cmd);
    const o = fm.override.get(cmd.type);
    if (o) {
      fm.override.delete(cmd.type);
      return o;
    }
    if (cmd.channel !== fm.channel) return { ok: false, error: 'session_not_found' };
    if (cmd.type === 'request_control') return null; // waits on the host
    if (!fm.granted) return { ok: false, error: 'not_granted' };
    switch (cmd.type) {
      case 'status':
        return { ok: true, type: 'status', state: 'playing', nowPlaying: fm.nowPlaying, queue: fm.queue, queueLimit: 50 };
      case 'search':
        return {
          ok: true,
          type: 'search',
          results: fm.catalog.filter((c) => cmd.query.toLowerCase().split(' ').some((w: string) => c.label.toLowerCase().includes(w))).map(({ label, reference }) => ({ label, reference })),
        };
      case 'add': {
        const hit = fm.catalog.find((c) => c.reference === cmd.reference);
        if (!hit) return { ok: false, error: 'not_found' };
        const t = { id: `t${++fm.seq}`, ...hit.track };
        fm.queue.push(t);
        return { ok: true, type: 'add', added: [{ id: t.id, title: t.title, artist: t.artist }] };
      }
      case 'skip': {
        const skipped = fm.nowPlaying;
        fm.nowPlaying = fm.queue.shift() ?? null;
        return skipped ? { ok: true, type: 'skip', skipped, nowPlaying: fm.nowPlaying } : { ok: false, error: 'nothing_playing' };
      }
      case 'move': {
        const i = fm.queue.findIndex((t) => t.id === cmd.trackId);
        if (i < 0) return { ok: false, error: 'not_found' };
        const [t] = fm.queue.splice(i, 1);
        fm.queue.unshift(t!);
        return { ok: true, type: 'move', position: 1, title: t!.title, artist: t!.artist };
      }
      case 'volume':
        return { ok: true, type: 'volume', volumePercent: cmd.percent };
      case 'release_control':
        fm.granted = false;
        return { ok: true, type: 'release_control', released: true };
      default:
        return { ok: true, type: cmd.type };
    }
  },
};

const song = (title: string, artist: string, label = `${title} - ${artist}`) => ({ label, reference: `ref:${label}`, track: { title, artist } });

describe.skipIf(!INTEGRATION)('huddlefm DJ mode', () => {
  let sql: typeof import('../../db/index.js').sql;
  let redis: typeof import('../../core/redis.js').redis;
  let inbound: typeof import('./inbound.js');
  let tools: typeof import('./tools.js');
  let store: typeof import('./store.js');
  let autodj: typeof import('./autodj.js');
  let protocol: typeof import('./protocol.js');
  let intake: typeof import('../../pipeline/intake.js');
  let fakeCalls: typeof import('../../core/slack-fake.js').fakeCalls;
  let removeHandler: () => void;

  let channelId: string;
  let threadId: string;
  let speaker = 'USPEAKER';
  const ctx = () => ({ role: 'front' as const, threadId, channelId, threadTs: threadId.split(':')[1]!, speakerId: speaker, turnId: Math.floor(Math.random() * 1e9), extras: {} });
  const exec = (t: any, input: object) => t.execute(input, { toolCallId: `tc${rand()}`, messages: [] });
  /** Deliver a message from HuddleFM through the real intake path. */
  const fromHfm = (msg: Record<string, unknown>, threadTs?: string) =>
    intake.handleMessageEvent({ type: 'message', channel: DM, channel_type: 'im', user: 'UHFM', bot_id: 'BHFM', ts: `${Date.now() / 1000}`, ...(threadTs ? { thread_ts: threadTs } : {}), text: JSON.stringify({ v: 1, ...msg }) } as any);
  const event = (event: string, payload: Record<string, unknown> = {}) => fromHfm({ type: 'event', channel: channelId, event, payload });
  const noticeTurns = (refPrefix: string) =>
    sql<any[]>`select t.*, i.input, i.fallback, i.source_ref from scheduled_turn_inputs i join turns t on t.id = i.turn_id
               where i.source = 'huddlefm' and i.source_ref like ${`${refPrefix}%`} and t.thread_id = ${threadId} order by t.id`;
  const requestTs = async () => (await store.getSession(channelId))!.requestTs!;

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    ({ redis } = await import('../../core/redis.js'));
    ({ fakeCalls } = await import('../../core/slack-fake.js'));
    const { migrate } = await import('../../db/migrate.js');
    await migrate();
    inbound = await import('./inbound.js');
    tools = await import('./tools.js');
    store = await import('./store.js');
    autodj = await import('./autodj.js');
    protocol = await import('./protocol.js');
    intake = await import('../../pipeline/intake.js');
    const { addFakeHandler } = await import('../../core/slack-fake.js');
    let n = 0;
    removeHandler = addFakeHandler((method, args) => {
      if (method !== 'chat.postMessage' || args.channel !== DM) return undefined;
      const cmd = protocol.decodeMessage(String(args.text));
      const ts = `${Math.floor(Date.now() / 1000)}.${String(++n).padStart(6, '0')}`;
      const reply = cmd ? fm.respond(cmd) : null;
      if (reply) setTimeout(() => void fromHfm({ replyTo: ts, ...reply }, ts), 5);
      return { ok: true, channel: DM, ts };
    });
  });

  afterAll(async () => {
    removeHandler?.();
    if (!sql) return;
    await sql.end();
    redis.disconnect();
  });

  beforeEach(async () => {
    channelId = `CHUD${rand()}`;
    speaker = `USPK${rand()}`;
    threadId = `${channelId}:1700000000.000100`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channelId}, '1700000000.000100') on conflict do nothing`;
    fm.reset(channelId);
    generateText.mockReset();
  });

  async function activate(opts: { autoDj?: boolean; chatter?: boolean } = {}) {
    const res = await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: true, auto_dj: opts.autoDj ?? false, chatter: opts.chatter ?? false });
    expect(res).toMatch(/Request sent/);
    fm.granted = true;
    await fromHfm({ type: 'grant_accepted', ok: true, replyTo: await requestTs(), permissions: ['add', 'skip'], nowPlaying: null, queue: [] });
    expect((await store.getSession(channelId))?.status).toBe('active');
  }

  it('requests control, then the host approves: active session + one announcement turn', async () => {
    const res = await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: true, vibe: 'chill lofi' });
    expect(res).toMatch(/Request sent.*Auto DJ will be on \(vibe: chill lofi\)/);
    const req = fm.commands.find((c) => c.type === 'request_control');
    expect(req).toMatchObject({ channel: channelId, permissions: expect.arrayContaining(['add', 'skip']), events: ['session', 'track', 'queue'] });
    expect(req!.permissions).not.toContain('end-session');
    const pending = await store.getSession(channelId);
    expect(pending).toMatchObject({ status: 'pending', requestedBy: speaker, originThreadId: threadId, autoDj: true, vibe: 'chill lofi' });
    expect(await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: true })).toMatch(/Already waiting/);

    fm.granted = true;
    const accepted = { type: 'grant_accepted', ok: true, replyTo: pending!.requestTs, permissions: ['add', 'skip'], nowPlaying: { id: 'x', title: 'Now', artist: 'Someone' }, queue: [] };
    await fromHfm(accepted);
    await fromHfm(accepted); // duplicate delivery: still one announcement
    const s = await store.getSession(channelId);
    expect(s).toMatchObject({ status: 'active', permissions: ['add', 'skip'] });
    expect(s!.playback?.nowPlaying).toBe('Now - Someone');
    const turns = await noticeTurns('grant_accepted:');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ authorId: speaker, kind: 'scheduled', isMention: true });
    expect(turns[0].input).toContain('<huddle_dj_notice>');
    expect(turns[0].fallback).toContain('the host let me on the aux');
    // HuddleFM's messages never become a conversation.
    expect(await sql`select 1 from threads where channel_id = ${DM}`).toHaveLength(0);
    expect(await sql`select 1 from messages where channel_id = ${DM}`).toHaveLength(0);
  }, 20_000);

  it('no HuddleFM session in the channel: tells the agent and leaves no row', async () => {
    fm.channel = 'COTHER';
    const res = await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: true });
    expect(res).toMatch(/no HuddleFM session/);
    expect(await store.getSession(channelId)).toBeNull();
  });

  it('declined: row gone, announcement with a fallback', async () => {
    await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: true });
    await fromHfm({ type: 'grant_declined', ok: true, replyTo: await requestTs() });
    expect(await store.getSession(channelId)).toBeNull();
    const [t] = await noticeTurns('grant_declined:');
    expect(t.fallback).toContain('said no');
  }, 20_000);

  it('cancelled while pending: a later approval is released right away', async () => {
    await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: true });
    const ts = await requestTs();
    expect(await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: false })).toMatch(/Cancelled/);
    fm.granted = true;
    await fromHfm({ type: 'grant_accepted', ok: true, replyTo: ts });
    await vi.waitFor(() => expect(fm.commands.at(-1)).toMatchObject({ type: 'release_control', channel: channelId }));
    expect(await noticeTurns('grant_accepted:')).toHaveLength(0);
  }, 20_000);

  it('huddle_dj: queues the matching version, plays it next, skips, sets volume', async () => {
    await activate();
    fm.nowPlaying = { id: 'p0', title: 'Playing', artist: 'Band' };
    fm.catalog = [song('Mr. Brightside', 'Sing King', 'Mr. Brightside (Karaoke Version) - Sing King'), song('Mr. Brightside', 'The Killers'), song('Other', 'Thing')];
    fm.queue = [{ id: 'q1', title: 'Other', artist: 'Thing' }];
    const out = JSON.parse(
      await exec(tools.djTools(ctx()).huddle_dj, {
        commands: [
          { command: 'add', query: 'mr brightside the killers', play_next: true },
          { command: 'skip' },
          { command: 'volume', percent: 40 },
        ],
      }),
    );
    expect(out.results.map((r: any) => r.ok)).toEqual([true, true, true]);
    expect(out.results[0].results[0].added).toEqual(['Mr. Brightside - The Killers']);
    expect(fm.commands.find((c) => c.type === 'add')?.reference).toBe('ref:Mr. Brightside - The Killers');
    expect(out.results[1]).toMatchObject({ skipped: ['Playing - Band'], nowPlaying: 'Mr. Brightside - The Killers' });
    expect((await store.getSession(channelId))!.requested).toContain('Mr. Brightside - The Killers');
  }, 20_000);

  it('huddle_dj: a lost grant ends DJ mode', async () => {
    await activate();
    fm.granted = false;
    const out = JSON.parse(await exec(tools.djTools(ctx()).huddle_dj, { commands: [{ command: 'pause' }, { command: 'volume', percent: 10 }] }));
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ ok: false, lost: true });
    expect(await store.getSession(channelId)).toBeNull();
    expect(await exec(tools.djTools(ctx()).huddle_dj, { commands: [{ command: 'status' }] })).toMatch(/DJ mode isn't on/);
  }, 20_000);

  it('controlling another channel needs the speaker to be in it', async () => {
    const res = await exec(tools.djTools({ ...ctx(), channelId: 'DUSER' }).huddle_dj, { channel: 'CNOTMINE1', commands: [{ command: 'status' }] });
    expect(res).toMatch(/isn't a member/);
    expect(await exec(tools.djTools({ ...ctx(), channelId: 'DUSER' }).huddle_dj_mode, { enabled: true })).toMatch(/This is a DM/);
  });

  it('auto DJ: tops up with matching, non-repeated picks and records them', async () => {
    await activate({ autoDj: true });
    await store.appendHistory(channelId, 'played', ['Africa - Toto']);
    fm.nowPlaying = { id: 'p0', title: 'Rosanna', artist: 'Toto' };
    fm.catalog = [
      song('Africa', 'Toto'),
      song('September', 'Earth, Wind & Fire'),
      song('Let It Go', 'Some Choir', 'September (Karaoke Version) - Sing King'),
      song('Dreams', 'Fleetwood Mac'),
      song('Go Your Own Way', 'Fleetwood Mac'),
    ];
    generateText.mockResolvedValue({
      output: {
        songs: [
          { title: 'Africa', artist: 'Toto' }, // played already
          { title: 'September', artist: 'Earth, Wind & Fire' },
          { title: 'Nonexistent Song', artist: 'Nobody' }, // no match
          { title: 'Dreams', artist: 'Fleetwood Mac' },
          { title: 'Go Your Own Way', artist: 'Fleetwood Mac' },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    await autodj.processDjSync({ id: 'j1', data: { channelId, reason: 'test' } } as Job);
    expect(fm.queue.map((t) => t.title)).toEqual(['September', 'Dreams', 'Go Your Own Way']);
    const s = await store.getSession(channelId);
    expect(s!.picks).toEqual(['September - Earth, Wind & Fire', 'Dreams - Fleetwood Mac', 'Go Your Own Way - Fleetwood Mac']);
    expect(s!.playback?.nowPlaying).toBe('Rosanna - Toto');
    const prompt = generateText.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('Africa - Toto');
    expect(prompt).toContain('Now playing: Rosanna - Toto');

    // Enough queued now: no model call.
    generateText.mockClear();
    await autodj.processDjSync({ id: 'j2', data: { channelId, reason: 'test' } } as Job);
    expect(generateText).not.toHaveBeenCalled();
  }, 30_000);

  it('auto DJ: a top-up that adds nothing backs off', async () => {
    await activate({ autoDj: true });
    generateText.mockResolvedValue({ output: { songs: [{ title: 'Nope', artist: 'Nobody' }] }, usage: {} });
    await autodj.processDjSync({ id: 'j1', data: { channelId, reason: 'test' } } as Job);
    expect((await store.getSession(channelId))!.topupFailures).toBe(1);
    expect(await redis.exists(`hfm:topup-backoff:${channelId}`)).toBe(1);
    await autodj.processDjSync({ id: 'j2', data: { channelId, reason: 'test' } } as Job);
    expect(generateText).toHaveBeenCalledTimes(1);
    // A new vibe tries again right away.
    expect(await exec(tools.djTools(ctx()).huddle_dj_settings, { vibe: 'disco' })).toMatch(/vibe "disco"/);
    expect(await redis.exists(`hfm:topup-backoff:${channelId}`)).toBe(0);
  }, 30_000);

  it('events: history, skip feedback, chatter with cooldown, session end', async () => {
    await activate({ chatter: true });
    await store.appendHistory(channelId, 'picks', ['Mine - Bot']);
    await event('queue.added', { id: 'a', title: 'Human Pick', artist: 'Person' });
    await event('queue.added', { id: 'b', title: 'Auto', artist: 'Play', automatic: true });
    await event('track.started', { id: 'c', title: 'Mine', artist: 'Bot' });
    await event('track.skipped', { id: 'c', title: 'Mine', artist: 'Bot' });
    await event('track.started', { id: 'a', title: 'Human Pick', artist: 'Person' });
    const s = (await store.getSession(channelId))!;
    expect(s.requested).toEqual(['Human Pick - Person']);
    expect(s.skipped).toEqual(['Mine - Bot']);
    expect(s.played).toEqual(['Mine - Bot', 'Human Pick - Person']);
    const chatter = await noticeTurns('chatter:');
    expect(chatter).toHaveLength(1); // the second start is inside the cooldown
    expect(chatter[0]).toMatchObject({ isMention: false, fallback: null });
    expect(chatter[0].input).toContain('"Mine - Bot" (your pick)');

    await event('queue.removed', { id: 'z', title: 'Broken', artist: 'Song', reason: 'failed' });
    expect((await noticeTurns('failed:'))[0].fallback).toContain('"Broken - Song" failed to download');

    await event('session.ended');
    expect(await store.getSession(channelId)).toBeNull();
    expect(await noticeTurns('ended:')).toHaveLength(1);
    await event('track.started', { id: 'q', title: 'Late', artist: 'Event' });
    expect(await noticeTurns('chatter:')).toHaveLength(1);
  }, 30_000);

  it('the per-turn state shows this channel’s session only', async () => {
    await activate();
    const { renderDjState } = await import('./render.js');
    expect(await renderDjState({ channelId, threadId, speakerId: speaker })).toContain(`<#${channelId}> (this channel): you're the DJ`);
    expect(await renderDjState({ channelId: 'CELSEWHERE', threadId: 'CELSEWHERE:1.0', speakerId: 'USOMEONE' })).toBe('');
    // In a DM, the speaker sees the sessions they started.
    expect(await renderDjState({ channelId: 'DSPEAKER', threadId: 'DSPEAKER:1.0', speakerId: speaker })).toContain(`<#${channelId}>`);
  }, 20_000);

  it('fake slack: posted commands carry encoded JSON', async () => {
    const before = (await fakeCalls()).length;
    await exec(tools.djTools(ctx()).huddle_dj_mode, { enabled: true });
    const post = (await fakeCalls()).slice(before).find((c) => c.method === 'chat.postMessage' && c.args.channel === DM);
    expect(post?.args.text).toMatch(/^\{"v":1,"type":"request_control"/);
    expect(post?.args.unfurl_links).toBe(false);
  }, 20_000);
});
