/** Stored attachments: forwards with the message, link unfurls from a later message_changed (not an edit). */
import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { threadIdOf } from '../core/events.js';
import { applyDelete, applyEdit, storeMessage, upsertThread } from './store.js';
import { renderMessages } from '../context/thread.js';

const channel = `CST${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ts = '1790000000.000100';
const threadId = threadIdOf(channel, ts);

afterAll(async () => {
  await sql`delete from messages where channel_id = ${channel}`;
  await sql`delete from threads where channel_id = ${channel}`;
  await sql.end();
  redis.disconnect();
});

describe('message attachments', () => {
  it('stores a forward with the message and an unfurl from message_changed, and the context shows both', async () => {
    await upsertThread({ id: threadId, channelId: channel, threadTs: ts, isDm: false });
    await storeMessage(channel, threadId, {
      ts,
      user: 'U0STOREX',
      text: 'see https://example.com/jam',
      attachments: [{ is_share: true, author_name: 'Sam', channel_name: 'events', text: 'Jam signups close Sunday' }, { is_share: true, text: '## hidden' }],
    });
    // Slack adds the link preview later, same text: stored, but not an edit.
    const res = await applyEdit(channel, {
      ts,
      user: 'U0STOREX',
      text: 'see https://example.com/jam',
      attachments: [
        { is_share: true, author_name: 'Sam', channel_name: 'events', text: 'Jam signups close Sunday' },
        { from_url: 'https://example.com/jam', title: 'Spring Jam', text: 'A weekend game jam' },
      ],
    });
    expect(res?.changed).toBe(false);
    const [row] = await sql<any[]>`select attachments, edited_at from messages where channel_id = ${channel} and ts = ${ts}`;
    expect(row.attachments.map((a: any) => a.kind)).toEqual(['forwarded', 'link']);
    expect(row.editedAt).toBeNull();
    const out = await renderMessages(threadId, [ts]);
    expect(out).toContain('[forwarded from Sam in #events: Jam signups close Sunday]');
    expect(out).toContain('[link preview: Spring Jam — A weekend game jam (https://example.com/jam)]');
    expect(out).not.toContain('hidden');

    // Deleted in Slack: the stored copy loses its attachments too (retention).
    await applyDelete(channel, ts);
    const [gone] = await sql<any[]>`select attachments from messages where channel_id = ${channel} and ts = ${ts}`;
    expect(gone.attachments).toEqual([]);
  });
});
