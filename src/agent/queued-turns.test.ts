/** renderQueuedTurns against the test database: queued user turns, and human messages no turn has taken yet. */
import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { threadIdOf } from '../core/events.js';
import { renderQueuedTurns, resultsAheadNote } from './front.js';
import type { TurnRow } from '../core/types.js';

const channel = `CQT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const now = new Date();
const s = Math.floor(now.getTime() / 1000);
const ts = (offset: number) => `${s + offset}.000100`;
const threadTs = ts(-3600);
const threadId = threadIdOf(channel, threadTs);

afterAll(async () => {
  await sql`delete from turns where thread_id = ${threadId}`;
  await sql`delete from messages where channel_id = ${channel}`;
  await sql`delete from threads where channel_id = ${channel}`;
  await sql.end();
  redis.disconnect();
});

describe('renderQueuedTurns', () => {
  it('lists pending user turns and newer human messages that are in no turn yet', async () => {
    await sql`insert into threads (id, channel_id, thread_ts, last_bot_reply_ts) values (${threadId}, ${channel}, ${threadTs}, ${ts(-120)})`;
    const msg = (t: string, user: string | null, bot: string | null = null) => ({ channel_id: channel, ts: t, thread_id: threadId, user_id: user, bot_id: bot, text: 'x' });
    await sql`insert into messages ${sql(
      [
        msg(ts(-3000), 'UOLD'), // before the bot's last reply
        msg(ts(-120), 'UBOT', 'BBOT'), // the bot's last reply
        msg(ts(-60), 'UANS'), // answered by a finished turn
        msg(ts(-30), 'UQUE'), // a pending turn
        msg(ts(-10), 'UNEW'), // in debounce / at the gate
        msg(ts(-5), 'UNEW'),
        msg(ts(-4), 'UOTHERBOT', 'BOTHER'), // another bot
      ],
      'channel_id', 'ts', 'thread_id', 'user_id', 'bot_id', 'text',
    )}`;
    await sql`insert into turns (thread_id, author_id, message_ts, status) values (${threadId}, 'UANS', ${[ts(-60)]}, 'done'), (${threadId}, 'UQUE', ${[ts(-30)]}, 'pending')`;
    const out = await renderQueuedTurns(threadId, now);
    expect(out).toContain(`Queued after this turn`);
    expect(out).toContain(`<@UQUE>: [${ts(-30)}]`);
    expect(out).toContain(`Still being handled`);
    expect(out).toContain(`<@UNEW>: [${ts(-10)}] [${ts(-5)}]`);
    expect(out).not.toMatch(/UOLD|UANS>: |UOTHERBOT/);
    // Nothing waiting: empty.
    await sql`update threads set last_bot_reply_ts = ${ts(0)} where id = ${threadId}`;
    await sql`update turns set status = 'done' where thread_id = ${threadId}`;
    expect(await renderQueuedTurns(threadId, now)).toBe('');
  });

  it('resultsAheadNote: only for a user turn that runs ahead of a waiting results turn', async () => {
    await sql`delete from turns where thread_id = ${threadId}`;
    const ins = async (kind: string, status = 'pending') =>
      (await sql<{ id: number }[]>`insert into turns (thread_id, author_id, kind, message_ts, status) values (${threadId}, 'U1', ${kind}, '{}', ${status}) returning id::int as id`)[0]!.id;
    const asTurn = (id: number) => ({ id, threadId, kind: 'user' }) as TurnRow;
    const before = await ins('user');
    const synth = await ins('synthesis');
    const user = await ins('user', 'running');
    expect(await resultsAheadNote(asTurn(user))).toContain("subagents' results came in");
    expect(await resultsAheadNote(asTurn(before))).toBe('');
    await sql`update turns set status = 'done' where id = ${synth}`;
    expect(await resultsAheadNote(asTurn(user))).toBe('');
  });
});
