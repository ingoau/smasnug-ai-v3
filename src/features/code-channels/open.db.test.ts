/**
 * Opening code channels end to end against the test database and the fake Slack (model calls mocked):
 * open_code_channel (fork / brief / DM origin / refused), invites, the move_to_code_channel button, the per-turn tool
 * gating and the parent tools' posts.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.CODE_CHANNELS = '1';
});
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: vi.fn(async () => ({ text: 'SEED SUMMARY: they want X. *Where it stands:* fix the login bug.', usage: { inputTokens: 10, outputTokens: 5 } })),
}));

import '../../tools/test-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { toolsFor, type ToolContext } from '../../core/tools.js';
import { addFakeHandler, fakeSlackError } from '../../core/slack-fake.js';
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { runButtonAction } from '../../agent/button-actions.js';
import { createReplyButtons, setButtonsMessage } from '../../agent/reply-buttons-store.js';
import { openCodeChannel } from './open.js';
import { parseParentMessage } from './parent-message.js';
import { setCodeChannelsDisabled } from './settings.js';
import { getCodeChannel, getCodeChannelBySession } from './store.js';
import { registerCodeChannelTools } from './tools.js';
import { hiddenToolsFor, loadCodeChannelTurnContext } from './turn-context.js';
import { deriveSessionId } from './ids.js';

registerCodeChannelTools();

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
let turnSeq = Math.floor(Math.random() * 1e9);
const created: string[] = [];
const threads: string[] = [];

async function sourceThread(o: { dm?: boolean; author?: string } = {}) {
  const channelId = `${o.dm ? 'D' : 'C'}SRC${rand()}`;
  const ts = '1700000000.000100';
  const threadId = `${channelId}:${ts}`;
  threads.push(threadId);
  await sql`insert into threads (id, channel_id, thread_ts, is_dm) values (${threadId}, ${channelId}, ${ts}, ${!!o.dm})`;
  const author = o.author ?? 'U0ASK';
  await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values
    (${channelId}, ${ts}, ${threadId}, ${author}, 'the login is broken'),
    (${channelId}, '1700000000.000200', ${threadId}, null, 'looking'),
    (${channelId}, '1700000000.000300', ${threadId}, ${author}, 'also can you redo the whole auth flow?')`;
  await sql`update messages set bot_id = 'BBOT', user_id = 'UBOT' where channel_id = ${channelId} and ts = '1700000000.000200'`;
  return { channelId, ts, threadId };
}

function frontCtx(threadId: string, speakerId = 'U0ASK', messageTs = ['1700000000.000300']) {
  const [channelId, threadTs] = threadId.split(':') as [string, string];
  const turnId = ++turnSeq;
  const state: any = { turn: { id: turnId, threadId, messageTs, kind: 'user', authorId: speakerId }, threadId, channelId, threadTs, visible: new Set(), spawned: new Set() };
  const ctx: Omit<ToolContext, 'role'> = { threadId, channelId, threadTs, speakerId, turnId, extras: { agentTurn: state } };
  return { ctx, state, tools: toolsFor('front', ctx), turnId };
}

const exec = (t: any, input: unknown) => t.execute(input, { toolCallId: 't1', messages: [] }) as Promise<string>;
// This file's own Slack calls (the shared fake call list in Redis is written by every test file at once), and
// channel ids unique across test processes.
const recorded: { method: string; args: any }[] = [];
let refuseCreate: string | null = null;
const sessions = new Map<string, string>();
addFakeHandler((method, args) => {
  recorded.push({ method, args });
  if (method !== 'agents.conversations.create') return undefined;
  if (refuseCreate) throw fakeSlackError(refuseCreate);
  // Like Slack: idempotent on session_id.
  const sid = String(args.session_id);
  if (!sessions.has(sid)) sessions.set(sid, `CCODE${rand()}${rand()}`);
  return { ok: true, channel_id: sessions.get(sid) };
});
const fakeCalls = async () => recorded;
const callsFor = async (channel: string) => recorded.filter((c) => c.args?.channel === channel || c.args?.channel_id === channel);

describe('code channels: opening and the agent tools', () => {
  beforeAll(async () => {
    await setCodeChannelsDisabled(false);
  });
  beforeEach(() => vi.mocked(generateText).mockClear());
  afterAll(async () => {
    if (created.length) await sql`delete from code_channels where channel_id in ${sql(created)}`;
    await sql`delete from threads where id in ${sql([...threads, ...created.map((c) => `${c}:0`)])}`;
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  it('fork: seed summary first, channel with the origin link, seed + quoted hand-off as a parent post, a link in the thread, and the turn ends', async () => {
    const src = await sourceThread();
    const { tools, state, turnId } = frontCtx(src.threadId);
    const out = await exec(tools.open_code_channel, { name: 'auth flow', fork: true });
    expect(out).toMatch(/Forked into <#C/);
    expect(out).toMatch(/do not reply/);
    expect(state.endRequested).toBe(true);
    expect(state.visible.has('code_channel')).toBe(true);
    expect(generateText).toHaveBeenCalledOnce();

    const row = (await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 })))!;
    created.push(row.channelId);
    expect(row).toMatchObject({ kind: 'fork', name: 'smasnug ai: auth flow', parentThreadId: src.threadId, originChannelId: src.channelId, originTs: '1700000000.000300', requesterId: 'U0ASK' });
    expect(row.seedSummary).toContain('SEED SUMMARY');
    expect(row.seedTs).toBeTruthy();

    const all = await fakeCalls();
    const create = all.find((c) => c.method === 'agents.conversations.create' && c.args.name === 'smasnug ai: auth flow')!;
    expect(create.args).toMatchObject({ origin_channel_id: src.channelId, origin_message_ts: '1700000000.000300' });
    expect(create.args.is_private).toBeUndefined();
    const inChannel = (await callsFor(row.channelId)).filter((c) => c.method === 'chat.postMessage');
    expect(inChannel[0]!.args.text).toMatch(/^Forked from <https:\/\/fake\.slack\.com\/archives\/.+\|this thread>\.\n\nSEED SUMMARY/);
    expect(inChannel[0]!.args.metadata).toBeUndefined(); // the seed starts no turn
    const handoff = inChannel[1]!.args;
    expect(handoff.username).toMatch(/· from #fake-channel$/);
    expect(handoff.text).toContain('> also can you redo the whole auth flow?');
    // Intake will take it as the requester's instruction for this channel's parent thread.
    expect(parseParentMessage(handoff)).toEqual({ parentThreadId: src.threadId, requesterId: 'U0ASK' });
    // The origin's author is invited by Slack: no explicit invite for them.
    expect((await callsFor(row.channelId)).some((c) => c.method === 'conversations.invite')).toBe(false);
    const link = (await callsFor(src.channelId)).find((c) => c.method === 'chat.postMessage')!;
    expect(link.args).toMatchObject({ thread_ts: src.ts });
    expect(link.args.text).toContain(`Continuing in <#${row.channelId}>`);

    // A retried call (same turn and ordinal) gets the same channel and posts nothing new.
    const before = (await fakeCalls()).length;
    const repeat = await (async () => {
      const ctx2 = frontCtx(src.threadId);
      ctx2.ctx.turnId = turnId;
      ctx2.state.turn.id = turnId;
      return exec(toolsFor('front', ctx2.ctx).open_code_channel, { name: 'auth flow', fork: true });
    })();
    expect(repeat).toContain(`<#${row.channelId}>`);
    expect(generateText).toHaveBeenCalledOnce(); // no second summary
    const after = (await fakeCalls()).slice(before).filter((c) => c.method === 'agents.conversations.create');
    expect(after.every((c) => c.args.session_id === row.sessionId)).toBe(true);
  });

  it('fork: a hand-off that starts no turn there (no consent yet, or the post failed) is reported truthfully and the turn goes on', async () => {
    const { privacySettings } = await import('../privacy.js');
    const was = privacySettings.required;
    privacySettings.required = true;
    await sql`insert into privacy_consent (user_id, policy_version) values ('U0ASK', 'test') on conflict do nothing`;
    try {
      const src = await sourceThread({ author: `U0NC${rand()}` });
      const { tools, state, turnId } = frontCtx(src.threadId);
      const out = await exec(tools.open_code_channel, { name: 'consent fork', fork: true });
      created.push((await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 })))!.channelId);
      expect(out).toMatch(/hasn't agreed to the privacy policy/);
      expect(out).not.toMatch(/do not reply/);
      expect(state.endRequested).toBeFalsy();
    } finally {
      privacySettings.required = was;
      await sql`delete from privacy_consent where user_id = 'U0ASK'`;
    }

    const src2 = await sourceThread();
    const undo = addFakeHandler((method, args) => (method === 'chat.postMessage' && args.metadata ? Promise.reject(fakeSlackError('invalid_arguments')) : undefined));
    try {
      const { tools, state, turnId } = frontCtx(src2.threadId);
      const out = await exec(tools.open_code_channel, { name: 'failed handoff', fork: true });
      created.push((await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 })))!.channelId);
      expect(out).toMatch(/Passing on the latest message failed/);
      expect(state.endRequested).toBeFalsy();
    } finally {
      undo();
    }
  });

  it('a private source with no origin link: created private (never left to Slack default), the row says so', async () => {
    const src = await sourceThread();
    const undo = addFakeHandler((method, args) =>
      method === 'conversations.info' && args.channel === src.channelId ? { ok: true, channel: { id: args.channel, name: 'secret', is_private: true, is_member: true } } : undefined,
    );
    try {
      const sessionId = `s-priv-${rand()}`;
      const res = await openCodeChannel({
        mode: 'task',
        name: 'secret work',
        sessionId,
        sourceThreadId: src.threadId,
        originTs: null,
        originAuthorId: null,
        requesterId: 'U0ASK',
        createdBy: 'U0ASK',
        explicitInvites: ['U0ASK'],
        brief: 'do it',
      });
      created.push(res.channel.channelId);
      expect(res.channel.isPrivate).toBe(true);
      const create = (await fakeCalls()).find((c) => c.method === 'agents.conversations.create' && c.args.session_id === sessionId)!;
      expect(create.args.is_private).toBe(true);
      expect(create.args.origin_channel_id).toBeUndefined();
    } finally {
      undo();
    }
  });

  it('a DM origin: private, no origin link, the requester invited explicitly; other members need confirmation', async () => {
    const src = await sourceThread({ dm: true });
    const undo = addFakeHandler((method, args) =>
      method === 'conversations.info' && String(args.channel).startsWith('DSRC') ? { ok: true, channel: { id: args.channel, is_im: true, user: 'U0ASK' } } : undefined,
    );
    try {
      const { tools, turnId } = frontCtx(src.threadId);
      const out = await exec(tools.open_code_channel, { name: 'side project', brief: 'Build the thing', members: ['<@U0OTHER>'] });
      expect(out).toMatch(/Opened <#C/);
      expect(out).toContain('<@U0OTHER> is only invited once the speaker confirms');
      const row = (await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 })))!;
      created.push(row.channelId);
      expect(row).toMatchObject({ kind: 'task', isPrivate: true, brief: 'Build the thing' });
      const create = (await fakeCalls()).find((c) => c.method === 'agents.conversations.create' && c.args.session_id === row.sessionId)!;
      expect(create.args.is_private).toBe(true);
      expect(create.args.origin_channel_id).toBeUndefined();
      const invite = (await callsFor(row.channelId)).find((c) => c.method === 'conversations.invite')!;
      expect(invite.args.users).toBe('U0ASK');
      // The brief is the first message, a parent post (its turn runs there).
      const brief = (await callsFor(row.channelId)).find((c) => c.method === 'chat.postMessage')!;
      expect(brief.args.text).toMatch(/^Brief from <@U0ASK>/);
      expect(parseParentMessage(brief.args)).toEqual({ parentThreadId: src.threadId, requesterId: 'U0ASK' });
      expect(brief.args.username).toMatch(/· from a DM$/);
      expect(generateText).not.toHaveBeenCalled(); // no seed summary for a brief
      // The confirmation: ephemeral to the requester in the DM thread.
      const confirm = (await callsFor(src.channelId)).find((c) => c.method === 'chat.postEphemeral')!;
      expect(confirm.args.user).toBe('U0ASK');
      expect(JSON.parse(confirm.args.blocks[1].elements[0].value)).toEqual({ c: row.channelId, u: ['U0OTHER'], r: 'U0ASK' });
    } finally {
      undo();
    }
  });

  it('members of the origin channel are invited directly', async () => {
    const src = await sourceThread();
    const { tools, turnId } = frontCtx(src.threadId);
    // The fake channel's members are UADMIN and UBOT.
    await exec(tools.open_code_channel, { name: 'pair', brief: 'Pair on it', members: ['UADMIN', 'U0STRANGER'] });
    const row = (await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 })))!;
    created.push(row.channelId);
    const invites = (await callsFor(row.channelId)).filter((c) => c.method === 'conversations.invite');
    expect(invites.map((c) => c.args.users)).toEqual(['UADMIN']);
    expect((await callsFor(src.channelId)).some((c) => c.method === 'chat.postEphemeral' && c.args.text.includes('<@U0STRANGER>'))).toBe(true);
  });

  it('Slack refusing: the user message comes back and nothing is recorded', async () => {
    const src = await sourceThread();
    refuseCreate = 'feature_disabled';
    try {
      const { tools, turnId } = frontCtx(src.threadId);
      const out = await exec(tools.open_code_channel, { name: 'nope', brief: 'x' });
      expect(out).toContain("Code channels aren't available in this workspace yet");
      expect(out).toContain('Nothing was created');
      expect(await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 }))).toBeNull();
    } finally {
      refuseCreate = null;
    }
  });

  it('the move button: origin = the reply, presser and requester invited, seed posted without a turn, a "Moved →" note', async () => {
    const src = await sourceThread();
    const buttons = await createReplyButtons({ threadId: src.threadId, channelId: src.channelId, turnId: ++turnSeq, key: `t-${rand()}`, labels: ['Move'], responses: [null], requesterId: 'U0ASK' });
    await setButtonsMessage(buttons.id, '1700000000.000200', 'looking');
    const out = await runButtonAction(
      { kind: 'action', tool: 'move_to_code_channel', args: JSON.stringify({ name: 'login bug' }) },
      { threadId: src.threadId, channelId: src.channelId, speakerId: 'U0PRESSER', key: String(buttons.id) },
    );
    expect(out.ok).toBe(true);
    expect(out.note).toMatch(/^Moved → <https:\/\/fake\.slack\.com\/archives\/C.+\|code channel>$/);
    const row = (await getCodeChannelBySession(deriveSessionId({ via: 'button', replyButtonsId: String(buttons.id), index: 0 })))!;
    created.push(row.channelId);
    expect(row).toMatchObject({ kind: 'fork', originTs: '1700000000.000200', createdBy: 'U0PRESSER', requesterId: 'U0ASK' });
    const calls = await callsFor(row.channelId);
    expect(calls.find((c) => c.method === 'conversations.invite')!.args.users).toBe('U0PRESSER,U0ASK');
    const posts = calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1); // the seed only: no hand-off, no turn
    expect(posts[0]!.args.metadata).toBeUndefined();
  });

  it('gating and parent tools: the parent thread gets ask/message, the channel gets views and report_to_parent', async () => {
    const src = await sourceThread();
    const { tools, turnId } = frontCtx(src.threadId);
    await exec(tools.open_code_channel, { name: 'parented', brief: 'Do it' });
    const row = (await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 })))!;
    created.push(row.channelId);

    const parent = await loadCodeChannelTurnContext(src.threadId, 'U0ASK');
    expect(parent.children.map((c) => c.channelId)).toContain(row.channelId);
    expect(hiddenToolsFor(parent).sort()).toEqual(['archive_code_channel', 'remove_view', 'report_to_parent', 'set_view']);
    const inside = await loadCodeChannelTurnContext(`${row.channelId}:0`, 'U0ASK');
    expect(inside.here?.channelId).toBe(row.channelId);
    expect(inside.topLevel).toBe(true);
    expect(hiddenToolsFor(inside).sort()).toEqual(['ask_code_channel', 'message_code_channel', 'open_code_channel']);

    // message_code_channel: a parent post (custom username + marker) in the channel's top level.
    const p = frontCtx(src.threadId);
    expect(await exec(p.tools.message_code_channel, { channel: `<#${row.channelId}>`, text: 'use postgres <!channel>' })).toContain('Posted in');
    const post = (await callsFor(row.channelId)).filter((c) => c.method === 'chat.postMessage').at(-1)!.args;
    expect(post.thread_ts).toBeUndefined();
    expect(post.text).not.toContain('<!channel>');
    expect(parseParentMessage(post)).toEqual({ parentThreadId: src.threadId, requesterId: 'U0ASK' });
    expect(await exec(p.tools.message_code_channel, { channel: 'CNOTMINE', text: 'x' })).toMatch(/isn't a code channel this thread opened/);

    // Inside: report_to_parent posts once per turn into the parent thread; set_view validates.
    const c = frontCtx(`${row.channelId}:0`, 'U0ASK', []);
    expect(await exec(c.tools.report_to_parent, { text: 'login fixed' })).toBe('Posted in the parent thread.');
    expect(await exec(c.tools.report_to_parent, { text: 'again' })).toMatch(/Already reported/);
    const report = (await callsFor(src.channelId)).filter((x) => x.method === 'chat.postMessage').at(-1)!.args;
    expect(report).toMatchObject({ thread_ts: src.ts });
    expect(report.text).toContain('login fixed');
    expect(await exec(c.tools.set_view, { view_key: 'status', type: 'html', name: 'Status', content: '<div>x</div>' })).toMatch(/complete documents/);
    expect(await exec(c.tools.set_view, { view_key: 'plan', type: 'canvas', name: 'Plan', canvas_id: 'FNOPE' })).toMatch(/isn't one you made/);
    expect(await exec(c.tools.set_view, { view_key: 'status', type: 'html', name: 'Status', content: '<!doctype html><html><body>ok</body></html>' })).toBe('Tab "Status" (status) is set.');
    const set = (await callsFor(row.channelId)).find((x) => x.method === 'agents.conversations.setView')!;
    expect(set.args).toMatchObject({ type: 'html', view_key: 'status', name: 'Status' });
    expect((await getCodeChannel(row.channelId))?.archivedAt).toBeNull();
  });

  it('a private child channel: only its members see it in the parent thread or can ask / message it', async () => {
    const src = await sourceThread();
    const { tools, turnId } = frontCtx(src.threadId);
    await exec(tools.open_code_channel, { name: 'private child', brief: 'Do it' });
    const row = (await getCodeChannelBySession(deriveSessionId({ via: 'tool', turnId: String(turnId), n: 0 })))!;
    created.push(row.channelId);
    await sql`update code_channels set is_private = true where channel_id = ${row.channelId}`;
    const undo = addFakeHandler((method, args) =>
      method === 'conversations.members' && args.channel === row.channelId ? { ok: true, members: ['U0MEM', 'UBOT'], response_metadata: { next_cursor: '' } } : undefined,
    );
    try {
      // Not a member: not listed, the parent tools hidden, and the tools refuse as for an unknown channel.
      const outsider = await loadCodeChannelTurnContext(src.threadId, 'U0ASK');
      expect(outsider.children.map((c) => c.channelId)).not.toContain(row.channelId);
      const o = frontCtx(src.threadId, 'U0ASK');
      expect(await exec(o.tools.ask_code_channel, { channel: `<#${row.channelId}>`, question: 'what is the status?' })).toMatch(/isn't a code channel this thread opened/);
      expect(await exec(o.tools.message_code_channel, { channel: `<#${row.channelId}>`, text: 'stop' })).toMatch(/isn't a code channel this thread opened/);
      expect(await exec(o.tools.message_code_channel, { channel: 'private', text: 'stop' })).not.toContain(row.channelId);
      // A member: listed, and the tools work.
      const member = await loadCodeChannelTurnContext(src.threadId, 'U0MEM');
      expect(member.children.map((c) => c.channelId)).toContain(row.channelId);
      const m = frontCtx(src.threadId, 'U0MEM');
      expect(await exec(m.tools.message_code_channel, { channel: `<#${row.channelId}>`, text: 'go on' })).toContain('Posted in');
    } finally {
      undo();
    }
  });

  it('switched off: every code-channel tool is hidden', async () => {
    const src = await sourceThread();
    await setCodeChannelsDisabled(true);
    try {
      const off = await loadCodeChannelTurnContext(src.threadId, 'U0ASK');
      expect(off.enabled).toBe(false);
      expect(hiddenToolsFor(off)).toContain('open_code_channel');
    } finally {
      await setCodeChannelsDisabled(false);
    }
  });
});
