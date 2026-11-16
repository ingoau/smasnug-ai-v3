/**
 * The code-channel lifecycle against the test database and the fake Slack (model calls mocked): the closing flow
 * (/archive, archive_code_channel, the sweep), /rename, slash routing outside code channels, and reopening.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.CODE_CHANNELS = '1';
});
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: vi.fn(async () => ({ text: '- fixed the login bug\n- tests added', usage: { inputTokens: 10, outputTokens: 5 } })),
}));

import '../../tools/test-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { env } from '../../config.js';
import { toolsFor, type ToolContext } from '../../core/tools.js';
import { addFakeHandler, fakeSlackError } from '../../core/slack-fake.js';
import { markThreadGone } from '../../core/slack.js';
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { handleSlash } from '../../pipeline/interactions.js';
import { processSlackEvent } from '../../pipeline/slack-events.js';
import { finalSessionStatus } from '../../pipeline/agent-session.js';
import { closeCodeChannel, sweepCodeChannels } from './lifecycle.js';
import { setCodeChannelsDisabled } from './settings.js';
import { CLOSE_MAX_ATTEMPTS, createCodeChannelRow, getCodeChannel } from './store.js';
import { registerCodeChannelTools } from './tools.js';

registerCodeChannelTools();

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const created: string[] = [];
const threads: string[] = [];
const recorded: { method: string; args: any }[] = [];
let archiveError: string | null = null;
addFakeHandler((method, args) => {
  recorded.push({ method, args });
  if (method === 'agents.conversations.archive' && archiveError) throw fakeSlackError(archiveError);
  return undefined;
});
const callsFor = (channel: string) => recorded.filter((c) => c.args?.channel === channel || c.args?.channel_id === channel);
const job = <D,>(data: D) => ({ data, id: 'test' }) as any;

async function codeChannel(o: { parent?: boolean } = {}) {
  const channelId = `CLIFE${rand()}${rand()}`;
  created.push(channelId);
  let parentThreadId: string | null = null;
  if (o.parent) {
    parentThreadId = `CPAR${rand()}:1700000000.000100`;
    threads.push(parentThreadId);
    const [ch, ts] = parentThreadId.split(':') as [string, string];
    await sql`insert into threads (id, channel_id, thread_ts) values (${parentThreadId}, ${ch}, ${ts})`;
  }
  const { row } = await createCodeChannelRow({ channelId, sessionId: `s-${channelId}`, kind: 'task', name: 'smasnug ai: login', parentThreadId, requesterId: 'U0REQ', createdBy: 'U0REQ' });
  await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values
    (${channelId}, '1700000001.000100', ${row.threadId}, 'U0REQ', 'fix the login bug please'),
    (${channelId}, '1700000001.000200', ${row.threadId}, 'U0REQ', 'and add tests')`;
  return row;
}

function slash(command: string, channelId: string, text = '', user = 'U0MEM') {
  return handleSlash({ user_id: user, command, channel_id: channelId, text, trigger_id: `trig${rand()}`, response_url: `https://hooks.fake/${rand()}` });
}

describe('code channels: lifecycle', () => {
  beforeAll(async () => {
    await setCodeChannelsDisabled(false);
  });
  beforeEach(() => {
    vi.mocked(generateText).mockClear();
    archiveError = null;
  });
  afterAll(async () => {
    if (created.length) await sql`delete from code_channels where channel_id in ${sql(created)}`;
    await sql`delete from threads where id in ${sql([...threads, ...created.map((c) => `${c}:0`)])}`;
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  it('/archive: closing summary in the channel, then the parent thread, then archive with its ts; row archived, session closed', async () => {
    const row = await codeChannel({ parent: true });
    await slash('/archive', row.channelId);
    expect(generateText).toHaveBeenCalledOnce();
    const calls = callsFor(row.channelId);
    const posts = calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args.text).toMatch(/^\*Closing summary\*\n- fixed the login bug/);
    expect(posts[0]!.args.text).toContain('<@U0MEM> asked to archive');
    expect(posts[0]!.args.thread_ts).toBeUndefined();

    const [parentCh, parentTs] = row.parentThreadId!.split(':');
    const parentPost = recorded.find((c) => c.method === 'chat.postMessage' && c.args.channel === parentCh)!;
    expect(parentPost.args).toMatchObject({ thread_ts: parentTs, text: `<#${row.channelId}> finished: - fixed the login bug\n- tests added` });

    const archive = calls.find((c) => c.method === 'agents.conversations.archive')!;
    expect(archive.args.summary_message_ts).toBeTruthy();
    const order = recorded.map((c) => c);
    expect(order.indexOf(posts[0]!)).toBeLessThan(order.indexOf(parentPost));
    expect(order.indexOf(parentPost)).toBeLessThan(order.indexOf(archive));

    expect((await getCodeChannel(row.channelId))!.archivedAt).not.toBeNull();
    const status = calls.filter((c) => c.method === 'agents.sessions.setStatus').map((c) => c.args);
    expect(status).toEqual([{ channel_id: row.channelId, status: 'closed' }]);
    expect(await finalSessionStatus(row.threadId)).toBe('closed');
    expect((await sql`select type, actor from thread_events where thread_id = ${row.threadId} and type = 'code_channel_archived'`)[0]).toMatchObject({ actor: 'U0MEM' });

    // A second /archive: nothing posted again, told ephemerally.
    const before = recorded.length;
    await slash('/archive', row.channelId);
    const after = recorded.slice(before);
    expect(after.filter((c) => c.method === 'chat.postMessage' || c.method === 'agents.conversations.archive')).toEqual([]);
    expect(after.find((c) => c.method === 'response_url')?.args.text).toMatch(/already archived/);
  });

  it('a retried attempt posts nothing twice; a deleted parent thread gets no post; archive errors are reported', async () => {
    const row = await codeChannel({ parent: true });
    const [parentCh, parentTs] = row.parentThreadId!.split(':') as [string, string];
    await markThreadGone(parentCh, parentTs);
    archiveError = 'not_authorized';
    const first = await closeCodeChannel({ channelId: row.channelId, actor: 'U0REQ', reason: 'agent', attemptKey: 'turn:1' });
    expect(first).toMatchObject({ ok: false, text: expect.stringMatching(/not allowed/) });
    expect((await getCodeChannel(row.channelId))!.archivedAt).toBeNull();
    archiveError = null;
    const second = await closeCodeChannel({ channelId: row.channelId, actor: 'U0REQ', reason: 'agent', attemptKey: 'turn:1' });
    expect(second).toMatchObject({ ok: true });
    // The idempotency key answers the repeat: one summary post at Slack's end.
    expect(callsFor(row.channelId).filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    expect(recorded.filter((c) => c.method === 'chat.postMessage' && c.args.channel === parentCh)).toEqual([]);
    expect((await getCodeChannel(row.channelId))!.archivedAt).not.toBeNull();
  });

  it('archive_code_channel: same flow, ends the turn', async () => {
    const row = await codeChannel();
    const state: any = { turn: { id: 1, threadId: row.threadId, messageTs: ['1700000001.000200'], kind: 'user', authorId: 'U0REQ' }, visible: new Set(), spawned: new Set() };
    const ctx: Omit<ToolContext, 'role'> = { threadId: row.threadId, channelId: row.channelId, threadTs: '0', speakerId: 'U0REQ', turnId: Math.floor(Math.random() * 1e9), extras: { agentTurn: state } };
    const tools = toolsFor('front', ctx) as any;
    const out = await tools.archive_code_channel.execute({}, { toolCallId: 't', messages: [] });
    expect(out).toMatch(/^Archived/);
    expect(state.endRequested).toBe(true);
    expect(callsFor(row.channelId).some((c) => c.method === 'agents.conversations.archive')).toBe(true);
    expect((await getCodeChannel(row.channelId))!.archivedAt).not.toBeNull();
  });

  it('/rename: agents.sessions.rename with the bot-name prefix and the row renamed; slash commands outside code channels are refused', async () => {
    const row = await codeChannel();
    await slash('/rename', row.channelId, 'auth rework');
    const rename = callsFor(row.channelId).find((c) => c.method === 'agents.sessions.rename')!;
    expect(rename.args).toEqual({ channel_id: row.channelId, title: `${env.BOT_DISPLAY_NAME}: auth rework` });
    expect((await getCodeChannel(row.channelId))!.name).toBe(`${env.BOT_DISPLAY_NAME}: auth rework`);

    const before = recorded.length;
    await slash('/rename', row.channelId, '   ');
    expect(recorded.slice(before).find((c) => c.method === 'response_url')?.args.text).toMatch(/Usage/);

    // Without the slash too (runtime commands); outside a code channel: an ephemeral refusal, no Slack action.
    const plain = `CPLAIN${rand()}`;
    const mark = recorded.length;
    await slash('archive', plain);
    await slash('/rename', plain, 'x');
    const out = recorded.slice(mark);
    expect(out.filter((c) => c.method.startsWith('agents.') || c.method === 'chat.postMessage')).toEqual([]);
    expect(out.filter((c) => c.method === 'response_url').map((c) => c.args.text)).toEqual(['That command only works in a code channel.', 'That command only works in a code channel.']);
  });

  it('sweep: day-6 warning (suspended), day-7 archive only after a day of warning; any message resets it', async () => {
    const fresh = await codeChannel();
    const quiet = await codeChannel({ parent: true });
    const warnedLongAgo = await codeChannel();
    const warnedJustNow = await codeChannel();
    await sql`update code_channels set last_activity_at = now() - interval '6 days 1 hour' where channel_id = ${quiet.channelId}`;
    await sql`update code_channels set last_activity_at = now() - interval '7 days 1 hour', warned_at = now() - interval '25 hours' where channel_id = ${warnedLongAgo.channelId}`;
    await sql`update code_channels set last_activity_at = now() - interval '7 days 1 hour', warned_at = now() - interval '1 hour' where channel_id = ${warnedJustNow.channelId}`;

    await sweepCodeChannels();
    expect(callsFor(fresh.channelId)).toEqual([]);
    const warn = callsFor(quiet.channelId);
    expect(warn.find((c) => c.method === 'chat.postMessage')!.args.text).toMatch(/quiet for 6 days/);
    expect(warn.find((c) => c.method === 'agents.sessions.setStatus')!.args).toEqual({ channel_id: quiet.channelId, status: 'suspended' });
    expect((await getCodeChannel(quiet.channelId))!.warnedAt).not.toBeNull();
    expect(await finalSessionStatus(quiet.threadId)).toBe('suspended');
    expect(callsFor(warnedLongAgo.channelId).some((c) => c.method === 'agents.conversations.archive')).toBe(true);
    expect(callsFor(warnedLongAgo.channelId).find((c) => c.method === 'chat.postMessage')!.args.text).toContain('after a week without messages');
    expect((await getCodeChannel(warnedLongAgo.channelId))!.archivedAt).not.toBeNull();
    expect(callsFor(warnedJustNow.channelId)).toEqual([]);

    // A second sweep doesn't warn again.
    const before = recorded.length;
    await sweepCodeChannels();
    expect(recorded.slice(before).filter((c) => c.args?.channel === quiet.channelId)).toEqual([]);

    // A message resets the clock and the warning.
    const { touchCodeChannel } = await import('./store.js');
    expect(await touchCodeChannel(quiet.channelId)).toMatchObject({ wasWarned: true });
    expect((await getCodeChannel(quiet.channelId))!.warnedAt).toBeNull();
  });

  it('sweep: a channel written in since the listing is not archived (the decision is re-made under the lock)', async () => {
    const row = await codeChannel();
    await sql`update code_channels set last_activity_at = now() - interval '7 days 1 hour', warned_at = now() - interval '25 hours' where channel_id = ${row.channelId}`;
    const { touchCodeChannel } = await import('./store.js');
    await touchCodeChannel(row.channelId);
    const res = await closeCodeChannel({ channelId: row.channelId, actor: null, reason: 'sweep', attemptKey: 'sweep:stale' });
    expect(res).toMatchObject({ ok: false, text: expect.stringMatching(/no longer idle/) });
    expect(callsFor(row.channelId)).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
    expect((await getCodeChannel(row.channelId))!.archivedAt).toBeNull();
  });

  it('sweep: a failing archive keeps its summary, backs off, and stops (at once for a refusal that will not change)', async () => {
    const row = await codeChannel();
    const idle = () => sql`update code_channels set last_activity_at = now() - interval '7 days 1 hour', warned_at = now() - interval '25 hours' where channel_id = ${row.channelId}`;
    await idle();
    const archives = () => callsFor(row.channelId).filter((c) => c.method === 'agents.conversations.archive').length;

    archiveError = 'internal_error';
    await sweepCodeChannels();
    let r = (await getCodeChannel(row.channelId))!;
    expect(r.archivedAt).toBeNull();
    expect(r.closeFailures).toBe(1);
    expect(r.closeRetryAt!.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    expect(r.closingSummary).toContain('fixed the login bug');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(archives()).toBe(1);

    // Backing off: the next sweep leaves it alone.
    await sweepCodeChannels();
    expect(archives()).toBe(1);

    // Due again: the kept summary is reused (no second model call); a refusal stops the sweep for good.
    await sql`update code_channels set close_retry_at = now() - interval '1 minute' where channel_id = ${row.channelId}`;
    archiveError = 'not_authorized';
    await sweepCodeChannels();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(archives()).toBe(2);
    r = (await getCodeChannel(row.channelId))!;
    expect(r.closeFailures).toBe(CLOSE_MAX_ATTEMPTS);
    await sql`update code_channels set close_retry_at = now() - interval '1 minute' where channel_id = ${row.channelId}`;
    await sweepCodeChannels();
    expect(archives()).toBe(2);

    // A message resets it all.
    const { touchCodeChannel } = await import('./store.js');
    await touchCodeChannel(row.channelId);
    r = (await getCodeChannel(row.channelId))!;
    expect(r).toMatchObject({ closeFailures: 0, closeRetryAt: null, closingSummary: null });
  });

  it('channel_unarchive reopens an archived code channel (live, clock restarted); channel_archive in Slack marks it archived', async () => {
    const row = await codeChannel();
    await sql`update code_channels set last_activity_at = now() - interval '8 days' where channel_id = ${row.channelId}`;
    await processSlackEvent(job({ kind: 'event', body: { event: { type: 'channel_archive', channel: row.channelId, user: 'U0MEM' } } }));
    expect((await getCodeChannel(row.channelId))!.archivedAt).not.toBeNull();
    expect(await finalSessionStatus(row.threadId)).toBe('closed');

    await processSlackEvent(job({ kind: 'event', body: { event: { type: 'group_unarchive', channel: row.channelId, user: 'U0MEM' } } }));
    const live = (await getCodeChannel(row.channelId))!;
    expect(live.archivedAt).toBeNull();
    expect(Date.now() - live.lastActivityAt.getTime()).toBeLessThan(60_000);
    expect(await finalSessionStatus(row.threadId)).toBe('active');
    expect((await sql`select type from thread_events where thread_id = ${row.threadId}`).map((e) => e.type)).toContain('code_channel_reopened');
  });
});
