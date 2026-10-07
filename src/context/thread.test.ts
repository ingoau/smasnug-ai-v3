import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler } from '../core/slack-fake.js';
import { threadIdOf } from '../core/events.js';
import { slackFixtureHandler, FIX_THREAD_TS } from './fixtures.js';
import { tsLabel } from './format.js';
import { renderMessages, renderThreadContext, renderThreadFacts, tsToUtc } from './thread.js';
import { registerSlackFiles, resolveFile } from '../files/store.js';
import { getUserInfo } from './users.js';
import { closeQueues, queue, QUEUE } from '../core/queues.js';
import { summaryJobId } from './summary.js';

const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadId = threadIdOf(channel, FIX_THREAD_TS);
const remove = addFakeHandler(slackFixtureHandler({ channel, replyCount: 40 }));

afterAll(async () => {
  remove();
  await sql`delete from threads where channel_id = ${channel}`;
  await sql`delete from messages where channel_id = ${channel}`;
  await sql`delete from files where channel_id = ${channel}`;
  await closeQueues();
  await sql.end();
  redis.disconnect();
});

describe('renderThreadContext', () => {
  it('backfills, renders parent + the replies that fit the window, channel context and file ids', async () => {
    const newTs = `${Number(FIX_THREAD_TS.split('.')[0]) + 40}.000100`; // last reply = the turn's new message
    const ctx = await renderThreadContext(threadId, { newMessageTs: [newTs] });

    const [t] = await sql`select backfilled from threads where id = ${threadId}`;
    expect(t!.backfilled).toBe(true);

    const lines = ctx.history.split('\n');
    expect(lines[0]).toContain('<@U0INGO> Ingo: Anyone know how to fix');
    const shot = /\[file (file_[a-z0-9]{10}): screenshot\.png, image, from Ingo\]/.exec(lines[0]!)?.[1];
    expect(shot).toBeDefined();
    expect(lines[0]).toMatch(/\[file file_[a-z0-9]{10}: budget\.csv, text, from Ingo\]/);
    // 38 visible replies - 1 new = 37: all fit (limits.contextReplies = 40), so nothing is omitted, but they're past
    // the compaction point (0.8 × 40), so a background summary update was requested for all but the newest 20.
    expect(lines[1]).toContain('reply number 1');
    expect(lines).toHaveLength(1 + 37);
    expect(ctx.summary).toBeUndefined();
    const job = await queue(QUEUE.threadSummary).getJob(summaryJobId(threadId, `${Number(FIX_THREAD_TS.split('.')[0]) + 19}.000100`));
    expect(job?.data).toEqual({ threadId, targetTs: `${Number(FIX_THREAD_TS.split('.')[0]) + 19}.000100` });
    await job?.remove();
    expect(ctx.history).toContain('[bot] CI Bot: Build #42 failed');
    const heic = /\[file (file_[a-z0-9]{10}): IMG_0042\.HEIC, image, from alice\]/.exec(ctx.history)?.[1];
    expect(heic).toBeDefined();
    expect(ctx.history).not.toContain('deleted');
    expect(ctx.history).not.toContain('has joined');
    expect(ctx.history).not.toContain(newTs);

    expect(ctx.newMessages).toMatch(/^\[\d+\.000100 · [\d-]+ [\d:]+ UTC\] <@U0BOB> Bob Builder: long message .* \[truncated\] \(edited\)$/);

    // A long thread and a self-contained new message: no channel background.
    expect(ctx.channelContext).toBe('');
    // Who started it, when, and the total reply count (38 visible replies, all shown).
    expect(ctx.threadFacts).toBe(`Started by <@U0INGO> Ingo on ${tsToUtc(FIX_THREAD_TS)}; 38 replies so far. The new messages are replies in this thread.`);

    // Second render: no new backfill, same ids.
    const again = await renderThreadContext(threadId, { newMessageTs: [] });
    expect(again.history).toContain(`[file ${shot}: screenshot.png`);
    expect(again.history).toContain(`[file ${heic}: IMG_0042.HEIC`);
    expect(again.history).not.toContain('not shown');
    expect(again.history.split('\n')).toHaveLength(1 + 38);

    // Backfill stored the parent's reactions; they render with names and "(you)" for the bot.
    const [parentRow] = await sql<any[]>`select reactions from messages where channel_id = ${channel} and ts = ${FIX_THREAD_TS}`;
    expect(parentRow.reactions).toEqual([
      { name: '+1', users: ['U0BOB', 'U0ALICE'], count: 2 },
      { name: 'eyes', users: ['UBOT'], count: 1 },
    ]);
    expect(again.history.split('\n')[0]).toMatch(/\[reactions: :\+1: ×2 \(Bob Builder, alice\), :eyes: \(you\)\]$/);
  });

  it('channel background: in a short thread, or when the new message points at something', async () => {
    const ch2 = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const rm = addFakeHandler(slackFixtureHandler({ channel: ch2, replyCount: 2 }));
    try {
      const short = await renderThreadContext(threadIdOf(ch2, FIX_THREAD_TS), { newMessageTs: [] });
      expect(short.channelContext.split('\n')).toEqual([
        expect.stringContaining('alice: morning all'),
        expect.stringContaining('Bob Builder: deploy went out'),
        expect.stringContaining('alice: lunch?'),
        expect.stringContaining('Bob Builder: after the parent'),
      ]);
    } finally {
      rm();
      await sql`delete from threads where channel_id = ${ch2}`;
      await sql`delete from messages where channel_id = ${ch2}`;
    }
    // The long thread: a pointing message ("^ thoughts?") brings it back.
    const pointTs = `${Number(FIX_THREAD_TS.split('.')[0]) + 41}.000100`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${pointTs}, ${threadId}, 'U0BOB', '<@UBOT> ^ thoughts?')`;
    const pointing = await renderThreadContext(threadId, { newMessageTs: [pointTs] });
    expect(pointing.channelContext).toContain('alice: morning all');
    await sql`delete from messages where channel_id = ${channel} and ts = ${pointTs}`;
  });

  it('renderMessages renders inbox messages in the same format', async () => {
    const ts = `${Number(FIX_THREAD_TS.split('.')[0]) + 39}.000100`;
    const out = await renderMessages(threadId, [ts]);
    const [heic] = await sql<{ id: string }[]>`select id from files where thread_id = ${threadId} and slack_file_id = 'F0HEIC'`;
    expect(out).toBe(`[${tsLabel(ts)}] <@U0ALICE> alice: here is the error log [file ${heic!.id}: IMG_0042.HEIC, image, from alice]`);
  });

  it('uploads are registered with metadata only, stable, scoped per thread and race-safe', async () => {
    const [heic] = await sql<any[]>`select * from files where thread_id = ${threadId} and slack_file_id = 'F0HEIC'`;
    expect(heic).toMatchObject({ origin: 'upload', ownerId: 'U0ALICE', channelId: channel, name: 'IMG_0042.HEIC', content: null, description: null });
    expect(heic.slackUrl).toContain('files.slack.com');
    // Another thread: its own registration (and id); this thread's id isn't usable there by a non-owner.
    const other = `${channel}:1.000000`;
    const there = await registerSlackFiles(other, [{ ts: '1.000000', userId: 'U0ALICE', botId: null, username: null, text: '', files: [{ id: 'F0HEIC', name: 'IMG_0042.HEIC', mimetype: 'image/heic' }] }]);
    expect(there.get('F0HEIC')?.id).not.toBe(heic.id);
    expect(await resolveFile(heic.id, { threadId: other, speakerId: 'U0BOB' })).toHaveProperty('error');
    expect(await resolveFile(heic.id, { threadId: other, speakerId: 'U0ALICE' })).toMatchObject({ id: heic.id });
    expect(await resolveFile(heic.id, { threadId, speakerId: 'U0BOB' })).toMatchObject({ id: heic.id });

    const files = Array.from({ length: 10 }, (_, i) => ({ id: `FRACE${i}`, name: `p${i}.png`, mimetype: 'image/png', size: 100 + i }));
    const msgs = files.map((f, i) => ({ ts: `1790000500.00000${i}`, userId: 'U0BOB', botId: null, username: null, text: '', files: [f] }));
    const results = await Promise.all([registerSlackFiles(threadId, msgs), registerSlackFiles(threadId, [...msgs].reverse()), registerSlackFiles(threadId, msgs.slice(3))]);
    const ids = files.map((f) => results[0].get(f.id)?.id);
    expect(new Set(ids).size).toBe(10);
    for (const r of results) for (const [k, v] of r) expect(results[0].get(k)?.id).toBe(v.id);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from files where thread_id = ${threadId} and slack_file_id like 'FRACE%'`;
    expect(n!.n).toBe(10);
    const [size] = await sql<{ size: string }[]>`select size from files where thread_id = ${threadId} and slack_file_id = 'FRACE3'`;
    expect(Number(size!.size)).toBe(103);
  });

  it('getUserInfo returns name, tz and avatar (cached)', async () => {
    const u = await getUserInfo('U0BOB');
    expect(u).toMatchObject({ name: 'Bob Builder', tz: 'America/New_York', image: 'https://avatars.slack-edge.com/bob_192.png', isBot: false });
    expect(await redis.get('slack:user:v3:U0BOB')).toContain('Bob Builder');
  });
});

describe('renderThreadFacts', () => {
  it('a fresh top-level message, or who started the thread and how much of it is shown', () => {
    expect(renderThreadFacts({ fresh: true, startedTs: '1790000000.000100', replies: 0, shownReplies: 0 })).toMatch(/new top-level message: it starts this thread/);
    expect(tsToUtc('1790000000.000100')).toBe('Monday 2026-09-21 14:13 UTC');
    expect(renderThreadFacts({ fresh: false, inThread: true, starter: '<@U1> Ingo', startedTs: '1790000000.000100', replies: 120, shownReplies: 25 })).toBe(
      'Started by <@U1> Ingo on Monday 2026-09-21 14:13 UTC; 120 replies so far (only the newest 25 are shown here). The new messages are replies in this thread.',
    );
    expect(renderThreadFacts({ fresh: false, startedTs: '1790000000.000100', replies: 1, shownReplies: 1 })).toBe('Started on Monday 2026-09-21 14:13 UTC; 1 reply so far.');
  });
});
