/** Code channels against the test database and the fake Slack: store, cache, retention, withdrawal, API, switch. */
import '../../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { env } from '../../config.js';
import { codeChannelThreadId } from '../../core/events.js';
import { redis } from '../../core/redis.js';
import { addFakeHandler, fakeCalls, fakeSlackError } from '../../core/slack-fake.js';
import { sql } from '../../db/index.js';
import { archiveCodeChannel, createCodeChannel } from './api.js';
import { CodeChannelError } from './errors.js';
import { deriveSessionId } from './ids.js';
import { codeChannelsEnabled, setCodeChannelsDisabled } from './settings.js';
import {
  createCodeChannelRow,
  forgetUserCodeChannelData,
  getCodeChannel,
  invalidateCodeChannelCache,
  isCodeChannel,
  listIdleCodeChannels,
  markCodeChannelArchived,
  markCodeChannelWarned,
  retainCodeChannels,
  touchCodeChannel,
  unarchiveCodeChannel,
} from './store.js';

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const channels: string[] = [];
const parents: string[] = [];

async function parentThread() {
  const channelId = `CPAR${rand()}`;
  const ts = `1700000000.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const id = `${channelId}:${ts}`;
  parents.push(id);
  await sql`insert into threads (id, channel_id, thread_ts) values (${id}, ${channelId}, ${ts})`;
  return { id, channelId, ts };
}

async function newRow(extra: Partial<Parameters<typeof createCodeChannelRow>[0]> = {}) {
  const channelId = `CCC${rand()}`;
  channels.push(channelId);
  return createCodeChannelRow({ channelId, sessionId: deriveSessionId({ via: 'tool', turnId: rand() }), kind: 'task', name: 'smasnug ai: test', ...extra });
}

afterAll(async () => {
  await sql`delete from code_channels where channel_id in ${sql(channels)}`;
  await sql`delete from messages where thread_id in ${sql([...parents, ...channels.map(codeChannelThreadId)])}`;
  await sql`delete from threads where id in ${sql([...parents, ...channels.map(codeChannelThreadId)])}`;
  await sql`delete from settings where key = 'code_channels_disabled'`;
  await sql.end();
  redis.disconnect();
});

describe('code_channels store', () => {
  it('creates the row and its conversation thread; a repeat returns the existing row', async () => {
    const parent = await parentThread();
    const { row, created } = await newRow({ parentThreadId: parent.id, origin: { channelId: parent.channelId, ts: parent.ts }, seedSummary: 'sum', requesterId: 'UREQ' });
    expect(created).toBe(true);
    expect(row.threadId).toBe(codeChannelThreadId(row.channelId));
    expect(row.originTs).toBe(parent.ts);
    const [thread] = await sql`select thread_ts from threads where id = ${row.threadId}`;
    expect(thread?.threadTs).toBe('0');

    const again = await createCodeChannelRow({ channelId: row.channelId, sessionId: row.sessionId, kind: 'fork', name: 'other' });
    expect(again.created).toBe(false);
    expect(again.row.kind).toBe('task');
    // Same session id, different channel id: still the existing row.
    const bySession = await createCodeChannelRow({ channelId: `CX${rand()}`, sessionId: row.sessionId, kind: 'task', name: 'x' });
    expect(bySession.created).toBe(false);
    expect(bySession.row.channelId).toBe(row.channelId);
  });

  it('isCodeChannel is cached and recognises a new channel at once', async () => {
    const id = `CCC${rand()}`;
    channels.push(id);
    expect(await isCodeChannel(id)).toBe(false);
    await createCodeChannelRow({ channelId: id, sessionId: deriveSessionId({ via: 'adopt', channelId: id }), kind: 'adopted', name: 'n' });
    expect(await isCodeChannel(id)).toBe(true);
    await sql`delete from code_channels where channel_id = ${id}`;
    expect(await isCodeChannel(id)).toBe(true); // cached
    invalidateCodeChannelCache(id);
    expect(await isCodeChannel(id)).toBe(false);
  });

  it('idle listing, warning, touch, archive and reopen', async () => {
    const { row } = await newRow();
    await sql`update code_channels set last_activity_at = now() - interval '6 days 1 hour' where channel_id = ${row.channelId}`;
    const sixDays = 6 * 24 * 3600 * 1000;
    expect((await listIdleCodeChannels({ idleMs: sixDays, warned: false, limit: 1000 })).map((r) => r.channelId)).toContain(row.channelId);
    expect(await markCodeChannelWarned(row.channelId)).toBe(true);
    expect(await markCodeChannelWarned(row.channelId)).toBe(false);
    expect((await listIdleCodeChannels({ idleMs: sixDays, warned: false, limit: 1000 })).map((r) => r.channelId)).not.toContain(row.channelId);
    expect((await listIdleCodeChannels({ idleMs: sixDays, warned: true, limit: 1000 })).map((r) => r.channelId)).toContain(row.channelId);

    expect(await touchCodeChannel(row.channelId)).toEqual({ wasWarned: true, wasArchived: false });
    const touched = await getCodeChannel(row.channelId);
    expect(touched?.warnedAt).toBeNull();
    expect((await listIdleCodeChannels({ idleMs: sixDays, limit: 1000 })).map((r) => r.channelId)).not.toContain(row.channelId);

    expect(await markCodeChannelArchived(row.channelId)).toBe(true);
    expect(await markCodeChannelArchived(row.channelId)).toBe(false);
    expect(await touchCodeChannel(row.channelId)).toEqual({ wasWarned: false, wasArchived: true });
    expect(await unarchiveCodeChannel(row.channelId)).toBe(true);
    expect((await getCodeChannel(row.channelId))?.archivedAt).toBeNull();
    expect(await touchCodeChannel(`CNOPE${rand()}`)).toBeNull();
  });

  it('retention: rows go with their conversation thread, seeds are blanked, archived idle rows deleted', async () => {
    const a = (await newRow({ seedSummary: 'old seed', brief: 'old brief' })).row;
    const b = (await newRow()).row;
    const c = (await newRow()).row;
    await sql`update code_channels set created_at = now() - interval '31 days' where channel_id = ${a.channelId}`;
    await sql`update code_channels set archived_at = now(), last_activity_at = now() - interval '31 days' where channel_id = ${b.channelId}`;
    const counts = await retainCodeChannels(30 * 24 * 3600 * 1000);
    expect(counts.blanked).toBeGreaterThanOrEqual(1);
    const after = await getCodeChannel(a.channelId);
    expect(after?.seedSummary).toBeNull();
    expect(after?.brief).toBeNull();
    expect(await getCodeChannel(b.channelId)).toBeNull();
    // The thread's retention delete cascades.
    await sql`delete from threads where id = ${c.threadId}`;
    expect(await getCodeChannel(c.channelId)).toBeNull();
  });

  it('withdrawal blanks seeds they asked for or whose threads they wrote in', async () => {
    const user = `UW${rand()}`;
    const parent = await parentThread();
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${parent.channelId}, ${parent.ts}, ${parent.id}, ${user}, 'hi')`;
    const viaParent = (await newRow({ parentThreadId: parent.id, seedSummary: 's1' })).row;
    const asked = (await newRow({ requesterId: user, brief: 'b' })).row;
    const other = (await newRow({ seedSummary: 'keep' })).row;
    expect(await forgetUserCodeChannelData(user)).toBe(2);
    expect((await getCodeChannel(viaParent.channelId))?.seedSummary).toBeNull();
    expect((await getCodeChannel(asked.channelId))?.brief).toBeNull();
    expect((await getCodeChannel(other.channelId))?.seedSummary).toBe('keep');
  });
});

describe('code channel API (fake Slack)', () => {
  it('create sends the origin link, omits is_private unless forced, and is idempotent per session', async () => {
    const sessionId = deriveSessionId({ via: 'tool', turnId: rand() });
    const first = await createCodeChannel({ name: 'smasnug ai: x', sessionId, origin: { channelId: 'CORIG', ts: '1.2' } });
    const second = await createCodeChannel({ name: 'smasnug ai: x', sessionId, origin: { channelId: 'CORIG', ts: '1.2' } });
    expect(second.channelId).toBe(first.channelId);
    // Filtered by session id: other test files share the fake's call log.
    const creates = async (id: string) => (await fakeCalls()).filter((c) => c.method === 'agents.conversations.create' && c.args.session_id === id);
    const calls = await creates(sessionId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ name: 'smasnug ai: x', session_id: sessionId, origin_channel_id: 'CORIG', origin_message_ts: '1.2' });
    const privateId = deriveSessionId({ via: 'tool', turnId: rand() });
    await createCodeChannel({ name: 'p', sessionId: privateId, isPrivate: true });
    expect((await creates(privateId))[0]?.args.is_private).toBe(true);
  });

  it('maps Slack refusals to CodeChannelError; already_archived is not an error', async () => {
    const off = addFakeHandler((method) => {
      if (method === 'agents.conversations.create') throw fakeSlackError('feature_disabled');
      if (method === 'agents.conversations.archive') throw fakeSlackError('already_archived');
    });
    try {
      const err = await createCodeChannel({ name: 'n', sessionId: deriveSessionId({ via: 'tool', turnId: rand() }) }).catch((e) => e);
      expect(err).toBeInstanceOf(CodeChannelError);
      expect(err.unavailable).toBe(true);
      expect(await archiveCodeChannel({ channelId: 'C1', idempotencyKey: rand() })).toEqual({ alreadyArchived: true });
    } finally {
      off();
    }
  });
});

describe('code_channels kill switch', () => {
  it('off unless CODE_CHANNELS=1, and the runtime setting turns it off', async () => {
    const prev = env.CODE_CHANNELS;
    try {
      env.CODE_CHANNELS = '0';
      expect(await codeChannelsEnabled()).toBe(false);
      env.CODE_CHANNELS = '1';
      expect(await codeChannelsEnabled()).toBe(true);
      await setCodeChannelsDisabled(true);
      expect(await codeChannelsEnabled()).toBe(false);
      await setCodeChannelsDisabled(false);
      expect(await codeChannelsEnabled()).toBe(true);
    } finally {
      env.CODE_CHANNELS = prev;
    }
  });
});
