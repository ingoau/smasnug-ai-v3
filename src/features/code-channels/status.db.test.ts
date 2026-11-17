/**
 * The automatic Status tab against the test database, Redis and the fake Slack (model calls mocked): created with the
 * channel, refreshed (coalesced) when a subagent starts and finishes, skipped when unchanged or archived, and
 * reserved from the agent's set_view / remove_view.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.CODE_CHANNELS = '1';
});
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: vi.fn(async () => ({ text: 'SUMMARY', usage: { inputTokens: 10, outputTokens: 5 } })),
}));

import '../../tools/test-env.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { toolsFor, type ToolContext } from '../../core/tools.js';
import { addFakeHandler } from '../../core/slack-fake.js';
import { queue, QUEUE } from '../../core/queues.js';
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { processCardRender } from '../../agent/cards.js';
import { spawnSubagent } from '../../agent/subagents.js';
import { deriveSessionId } from './ids.js';
import { openCodeChannel } from './open.js';
import { setCodeChannelsDisabled } from './settings.js';
import { processCodeChannelStatus, refreshCodeChannelStatus } from './status.js';
import { STATUS_VIEW_KEY } from './status-view.js';
import { markCodeChannelArchived } from './store.js';
import { registerCodeChannelTools } from './tools.js';

registerCodeChannelTools();

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const threads: string[] = [];
const recorded: { method: string; args: any }[] = [];
const sessions = new Map<string, string>();
addFakeHandler((method, args) => {
  recorded.push({ method, args });
  if (method !== 'agents.conversations.create') return undefined;
  const sid = String(args.session_id);
  if (!sessions.has(sid)) sessions.set(sid, `CSTAT${rand()}${rand()}`);
  return { ok: true, channel_id: sessions.get(sid) };
});
const statusViews = (channel: string) =>
  recorded.filter((c) => c.method === 'agents.conversations.setView' && c.args.channel_id === channel && c.args.view_key === STATUS_VIEW_KEY);
const lastStatusText = (channel: string) => JSON.stringify(statusViews(channel).at(-1)?.args.blocks ?? []);

describe('code channels: the Status tab', () => {
  let channelId = '';

  beforeAll(async () => {
    await setCodeChannelsDisabled(false);
  });
  afterAll(async () => {
    if (channelId) await sql`delete from code_channels where channel_id = ${channelId}`;
    const ids: string[] = [...threads, `${channelId}:0`];
    await sql`delete from threads where id in ${sql(ids)}`;
    await queue(QUEUE.codeChannelStatus).obliterate({ force: true }).catch(() => {});
    await queue(QUEUE.subagentRun).drain().catch(() => {});
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  it('is set right after the channel is created', async () => {
    const src = `CSRC${rand()}`;
    const ts = '1700000000.000100';
    threads.push(`${src}:${ts}`);
    await sql`insert into threads (id, channel_id, thread_ts, is_dm) values (${`${src}:${ts}`}, ${src}, ${ts}, false)`;
    const res = await openCodeChannel({
      mode: 'task',
      name: 'status test',
      sessionId: deriveSessionId({ via: 'tool', turnId: rand(), n: 0 }),
      sourceThreadId: `${src}:${ts}`,
      originTs: ts,
      originAuthorId: 'U0ASK',
      requesterId: 'U0ASK',
      createdBy: 'U0ASK',
      explicitInvites: ['U0ASK'],
      brief: 'Fix the login bug\nwith details',
    });
    channelId = res.channel.channelId;
    const views = statusViews(channelId);
    expect(views).toHaveLength(1);
    expect(views[0]!.args).toMatchObject({ type: 'block_kit', view_key: 'status', name: 'Status' });
    // After setCommands.
    const order = recorded.filter((c) => c.args?.channel_id === channelId).map((c) => c.method);
    expect(order.indexOf('agents.conversations.setCommands')).toBeLessThan(order.indexOf('agents.conversations.setView'));
    const text = lastStatusText(channelId);
    expect(text).toContain('*Task:* Fix the login bug');
    expect(text).toContain('Opened by <@U0ASK>');
    expect(text).toContain('Nothing running.');

    // Unchanged state: no new setView.
    await refreshCodeChannelStatus(channelId);
    expect(statusViews(channelId)).toHaveLength(1);
  });

  it('a subagent start schedules one coalesced refresh, which shows it; finishing moves it to recently finished', async () => {
    const threadId = `${channelId}:0`;
    const [turn] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status) values (${threadId}, 'U0ASK', 'running') returning id`;
    const s = await spawnSubagent({ threadId, turnId: Number(turn!.id), ownerId: 'U0ASK', title: 'Build the login page', instructions: 'do it', sandbox: true });
    await queue(QUEUE.subagentRun).remove(`run-${s.runId}`).catch(() => {});
    // The run's card render (every run start / finish / cancel goes through it) asks for a refresh.
    await processCardRender(s.cardId);
    await processCardRender(s.cardId); // a burst: still one job
    const jobs = (await queue(QUEUE.codeChannelStatus).getDelayed()).filter((j) => j.data?.channelId === channelId);
    expect(jobs).toHaveLength(1);
    await processCodeChannelStatus(jobs[0]! as Job);
    await jobs[0]!.remove().catch(() => {});
    expect(statusViews(channelId)).toHaveLength(2);
    let text = lastStatusText(channelId);
    expect(text).toContain('*Running* (1)');
    expect(text).toContain('*Build the login page* · sandbox · queued');

    await sql`update runs set status = 'complete', started_at = now(), finished_at = now() where id = ${s.runId}`;
    await refreshCodeChannelStatus(channelId);
    text = lastStatusText(channelId);
    expect(text).toContain('Nothing running.');
    expect(text).toContain('*Recently finished*');
    expect(text).toContain('*Build the login page* · sandbox · done');
  });

  it('the agent cannot set or remove the status tab; its limit is 9', async () => {
    const ctx: Omit<ToolContext, 'role'> = { threadId: `${channelId}:0`, channelId, threadTs: '0', speakerId: 'U0ASK', turnId: 1, extras: {} };
    const tools = toolsFor('front', ctx) as any;
    const exec = (t: any, input: unknown) => t.execute(input, { toolCallId: 't1', messages: [] }) as Promise<string>;
    const before = recorded.length;
    expect(await exec(tools.set_view, { view_key: 'status', type: 'block_kit', name: 'Mine', blocks: [{ type: 'divider' }] })).toMatch(/automatic Status tab/);
    expect(await exec(tools.remove_view, { view_key: 'status' })).toMatch(/automatic Status tab/);
    expect(recorded.slice(before).some((c) => c.method === 'agents.conversations.setView' || c.method === 'agents.conversations.removeView')).toBe(false);

    const nine = [{ view_key: 'status' }, ...Array.from({ length: 9 }, (_, k) => ({ view_key: `v${k}` }))];
    addFakeHandler((method, args) => (method === 'agents.conversations.listViews' && args.channel_id === channelId ? { ok: true, views: nine } : undefined));
    expect(await exec(tools.set_view, { view_key: 'v10', type: 'block_kit', name: 'Ten', blocks: [{ type: 'divider' }] })).toMatch(/already has 9 tabs besides Status/);
    expect(await exec(tools.set_view, { view_key: 'v3', type: 'block_kit', name: 'Update', blocks: [{ type: 'divider' }] })).toMatch(/is set/);
  });

  it('archived channels are skipped', async () => {
    await sql`update code_channels set last_activity_at = now() - interval '1 minute' where channel_id = ${channelId}`;
    await markCodeChannelArchived(channelId);
    const n = statusViews(channelId).length;
    await refreshCodeChannelStatus(channelId);
    expect(statusViews(channelId)).toHaveLength(n);
  });
});
