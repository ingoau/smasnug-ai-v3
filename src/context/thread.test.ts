import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler } from '../core/slack-fake.js';
import { threadIdOf } from '../core/events.js';
import { slackFixtureHandler, FIX_THREAD_TS } from './fixtures.js';
import { renderMessages, renderThreadContext } from './thread.js';
import { assignImageIds, getThreadImage } from './images.js';
import { getUserInfo } from './users.js';

const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadId = threadIdOf(channel, FIX_THREAD_TS);
const remove = addFakeHandler(slackFixtureHandler({ channel, replyCount: 40 }));

afterAll(async () => {
  remove();
  await sql`delete from threads where channel_id = ${channel}`;
  await sql`delete from messages where channel_id = ${channel}`;
  await sql.end();
  redis.disconnect();
});

describe('renderThreadContext', () => {
  it('backfills, renders parent + last 29 replies, channel context and images', async () => {
    const newTs = `${Number(FIX_THREAD_TS.split('.')[0]) + 40}.000100`; // last reply = the turn's new message
    const ctx = await renderThreadContext(threadId, { newMessageTs: [newTs] });

    const [t] = await sql`select backfilled, next_image_n from threads where id = ${threadId}`;
    expect(t!.backfilled).toBe(true);

    const lines = ctx.history.split('\n');
    expect(lines[0]).toContain('<@U0INGO> Ingo: Anyone know how to fix');
    expect(lines[0]).toContain('[image img_1: screenshot.png, from Ingo]');
    expect(lines[1]).toBe('[8 earlier replies not shown]'); // 38 visible replies - 1 new - 29 shown
    expect(lines).toHaveLength(1 + 1 + 29);
    expect(ctx.history).toContain('[bot] CI Bot: Build #42 failed');
    expect(ctx.history).toContain('[image img_2: IMG_0042.HEIC, from alice]');
    expect(ctx.history).not.toContain('deleted');
    expect(ctx.history).not.toContain('has joined');
    expect(ctx.history).not.toContain(newTs);

    expect(ctx.newMessages).toMatch(/^\[\d+\.000100\] <@U0BOB> Bob Builder: long message .* \[truncated\] \(edited\)$/);

    const chan = ctx.channelContext.split('\n');
    expect(chan).toEqual([
      expect.stringContaining('alice: morning all'),
      expect.stringContaining('Bob Builder: deploy went out'),
      expect.stringContaining('alice: lunch?'),
      expect.stringContaining('Bob Builder: after the parent'),
    ]);

    // Second render: no new backfill, same ids.
    const again = await renderThreadContext(threadId, { newMessageTs: [] });
    expect(again.history).toContain('[image img_1: screenshot.png');
    expect(again.history).toContain('[image img_2: IMG_0042.HEIC');
    expect(again.history).toContain('[9 earlier replies not shown]');

    // Backfill stored the parent's reactions; they render with names and "(you)" for the bot.
    const [parentRow] = await sql<any[]>`select reactions from messages where channel_id = ${channel} and ts = ${FIX_THREAD_TS}`;
    expect(parentRow.reactions).toEqual([
      { name: '+1', users: ['U0BOB', 'U0ALICE'], count: 2 },
      { name: 'eyes', users: ['UBOT'], count: 1 },
    ]);
    expect(again.history.split('\n')[0]).toMatch(/\[reactions: :\+1: ×2 \(Bob Builder, alice\), :eyes: \(you\)\]$/);
  });

  it('renderMessages renders inbox messages in the same format', async () => {
    const ts = `${Number(FIX_THREAD_TS.split('.')[0]) + 39}.000100`;
    const out = await renderMessages(threadId, [ts]);
    expect(out).toBe(`[${ts}] <@U0ALICE> alice: here is the error log [image img_2: IMG_0042.HEIC, from alice]`);
  });

  it('image ids are stable, scoped per thread and race-safe', async () => {
    const img = await getThreadImage(threadId, 'img_2');
    expect(img?.fileId).toBe('F0HEIC');
    expect(img?.urlPrivate).toContain('files.slack.com');
    expect(await getThreadImage(`${channel}:1.000000`, 'img_2')).toBeNull();

    const files = Array.from({ length: 10 }, (_, i) => ({ id: `FRACE${i}`, name: `p${i}.png`, mimetype: 'image/png' }));
    const msgs = files.map((f, i) => ({ ts: `1790000500.00000${i}`, userId: 'U0BOB', botId: null, username: null, text: '', files: [f] }));
    const results = await Promise.all([assignImageIds(threadId, msgs), assignImageIds(threadId, [...msgs].reverse()), assignImageIds(threadId, msgs.slice(3))]);
    const ns = files.map((f) => results[0].get(f.id));
    expect(new Set(ns).size).toBe(10);
    for (const r of results) for (const [k, v] of r) expect(results[0].get(k)).toBe(v);
    const [t] = await sql`select next_image_n from threads where id = ${threadId}`;
    expect(t!.nextImageN).toBe(13);
  });

  it('getUserInfo returns name, tz and avatar (cached)', async () => {
    const u = await getUserInfo('U0BOB');
    expect(u).toMatchObject({ name: 'Bob Builder', tz: 'America/New_York', image: 'https://avatars.slack-edge.com/bob_192.png', isBot: false });
    expect(await redis.get('slack:user:U0BOB')).toContain('Bob Builder');
  });
});
