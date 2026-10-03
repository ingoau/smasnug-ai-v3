// OWNER: pipeline module. Turn scheduling: pending turns, inbox pushes and turn state transitions.
//
// Locking: every scheduling transaction first takes the thread row lock (`select … from threads for update`), then
// turn rows. Phase changes (`setPhase`) take the running turn's row lock. So "is a same-author turn running in
// phase 'tools'?" + inbox insert can never interleave with the turn finishing or switching to 'final'.
import type { TransactionSql } from 'postgres';
import { sql } from '../db/index.js';

type Tx = TransactionSql<{}>;
import { enqueue, QUEUE } from '../core/queues.js';
import type { StoredMessage, TurnRow } from '../core/types.js';
import { parseThreadId } from '../core/events.js';
import { compareTs } from './rules.js';
import { loadMessages } from './store.js';

const TURN_COLS = sql`id::int as id, thread_id, author_id, kind, is_mention, message_ts, card_id::int as card_id, status, phase`;

async function lockThread(tx: Tx, threadId: string) {
  await tx`select id from threads where id = ${threadId} for update`;
}

const mergeTs = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort(compareTs);

/** Make sure some worker will drain the thread's pending turns. Duplicate jobs are harmless (lock contention → no-op). */
export async function ensureThreadRun(threadId: string) {
  await enqueue(QUEUE.threadRun, { threadId });
}

/**
 * Create a pending turn for a thread and make sure a thread-run job will process it.
 * Used by the agent module to request a synthesis turn when all runs on a card have finished.
 */
export async function requestTurn(opts: {
  threadId: string;
  authorId: string;
  kind: TurnRow['kind'];
  cardId?: number;
  messageTs?: string[];
  isMention?: boolean;
}): Promise<number> {
  const id = await sql.begin(async (tx) => {
    await lockThread(tx, opts.threadId);
    if (opts.kind === 'user') return addToPendingTurnTx(tx, opts.threadId, opts.authorId, opts.messageTs ?? [], opts.isMention ?? false);
    const [row] = await tx<{ id: number }[]>`
      insert into turns (thread_id, author_id, kind, is_mention, message_ts, card_id)
      values (${opts.threadId}, ${opts.authorId}, ${opts.kind}, ${opts.isMention ?? false}, ${opts.messageTs ?? []}::text[], ${opts.cardId ?? null})
      returning id::int as id`;
    return row!.id;
  });
  await ensureThreadRun(opts.threadId);
  return id;
}

/** Append to the author's pending user turn, or create one. Caller holds the thread row lock. */
async function addToPendingTurnTx(tx: Tx, threadId: string, authorId: string, ts: string[], isMention: boolean): Promise<number> {
  const [pending] = await tx<{ id: number; messageTs: string[] }[]>`
    select id::int as id, message_ts from turns
    where thread_id = ${threadId} and author_id = ${authorId} and kind = 'user' and status = 'pending'
    order by id limit 1 for update`;
  if (pending) {
    await tx`update turns set message_ts = ${mergeTs(pending.messageTs, ts)}::text[], is_mention = is_mention or ${isMention}
             where id = ${pending.id}`;
    return pending.id;
  }
  const [row] = await tx<{ id: number }[]>`
    insert into turns (thread_id, author_id, kind, is_mention, message_ts)
    values (${threadId}, ${authorId}, 'user', ${isMention}, ${mergeTs([], ts)}::text[])
    returning id::int as id`;
  return row!.id;
}

export type ScheduleResult = { kind: 'inbox'; turnId: number } | { kind: 'turn'; turnId: number };

/**
 * If the thread's running turn belongs to the same author, is in phase 'tools' and no turn of theirs is already
 * waiting, push the messages into its inbox. Returns the running turn id, or null.
 */
export async function pushToRunningTurn(threadId: string, authorId: string, ts: string[], isMention: boolean): Promise<number | null> {
  return sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    const [running] = await tx<{ id: number; authorId: string; phase: string | null; kind: string }[]>`
      select id::int as id, author_id, phase, kind from turns
      where thread_id = ${threadId} and status = 'running' order by id desc limit 1 for update`;
    if (!running || running.authorId !== authorId || running.phase !== 'tools' || running.kind !== 'user') return null;
    const [waiting] = await tx`select 1 from turns where thread_id = ${threadId} and author_id = ${authorId} and status = 'pending' limit 1`;
    if (waiting) return null; // keep order: the author's newer messages queue behind their waiting turn
    for (const t of ts) {
      await tx`insert into thread_inbox (turn_id, message_ts, is_mention) values (${running.id}, ${t}, ${isMention})`;
    }
    return running.id;
  });
}

/** Debounced batch → inbox push into the author's running turn, or a (new or extended) pending turn + thread-run. */
export async function scheduleMessages(threadId: string, authorId: string, ts: string[], isMention: boolean, opts: { allowInbox?: boolean } = {}): Promise<ScheduleResult> {
  if (opts.allowInbox !== false) {
    const turnId = await pushToRunningTurn(threadId, authorId, ts, isMention);
    if (turnId != null) return { kind: 'inbox', turnId };
  }
  const turnId = await sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    return addToPendingTurnTx(tx, threadId, authorId, ts, isMention);
  });
  await ensureThreadRun(threadId);
  return { kind: 'turn', turnId };
}

// ---- turn lifecycle (called by the thread-run holder) ----

export async function claimNextPending(threadId: string): Promise<TurnRow | null> {
  return sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    const [next] = await tx<{ id: number }[]>`
      select id::int as id from turns where thread_id = ${threadId} and status = 'pending' order by id limit 1 for update`;
    if (!next) return null;
    const [turn] = await tx<TurnRow[]>`
      update turns set status = 'running', phase = 'tools', started_at = now() where id = ${next.id} returning ${TURN_COLS}`;
    return turn!;
  });
}

export async function hasPendingTurns(threadId: string): Promise<boolean> {
  const [row] = await sql`select 1 from turns where thread_id = ${threadId} and status = 'pending' limit 1`;
  return Boolean(row);
}

/** Mark unconsumed inbox rows consumed and return their (non-deleted) messages; records them on the turn. */
export async function drainInbox(turnId: number, threadId: string): Promise<StoredMessage[]> {
  const rows = await sql<{ messageTs: string }[]>`
    update thread_inbox set consumed_at = now() where turn_id = ${turnId} and consumed_at is null returning message_ts`;
  if (rows.length === 0) return [];
  const ts = rows.map((r) => r.messageTs).sort(compareTs);
  await sql`update turns set message_ts = (select array_agg(distinct t) from unnest(message_ts || ${ts}::text[]) t) where id = ${turnId}`;
  return loadMessages(parseThreadId(threadId).channelId, ts);
}

export async function setPhase(turnId: number, phase: 'tools' | 'final') {
  await sql`update turns set phase = ${phase} where id = ${turnId} and status = 'running'`;
}

/**
 * Finish a running turn. Inbox rows it never drained move into a new pending turn for the same author (the holder
 * loop picks it up next). Returns the id of that follow-up turn, if any.
 */
export async function finishTurn(turnId: number, status: 'done' | 'error' | 'cancelled'): Promise<number | null> {
  return sql.begin(async (tx) => {
    const [t] = await tx<{ threadId: string }[]>`select thread_id from turns where id = ${turnId}`;
    if (!t) return null;
    await lockThread(tx, t.threadId);
    const [turn] = await tx<{ authorId: string; status: string }[]>`select author_id, status from turns where id = ${turnId} for update`;
    if (!turn || turn.status !== 'running') return null;
    await tx`update turns set status = ${status}, phase = null, finished_at = now() where id = ${turnId}`;
    const left = await tx<{ messageTs: string; isMention: boolean }[]>`
      update thread_inbox set consumed_at = now() where turn_id = ${turnId} and consumed_at is null returning message_ts, is_mention`;
    if (left.length === 0) return null;
    return addToPendingTurnTx(
      tx,
      t.threadId,
      turn.authorId,
      left.map((r) => r.messageTs),
      left.some((r) => r.isMention),
    );
  });
}

/** A deleted message leaves pending turns and unconsumed inbox rows; turns left empty are cancelled. */
export async function removeMessageFromTurns(threadId: string, ts: string) {
  await sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    await tx`
      delete from thread_inbox where message_ts = ${ts} and consumed_at is null
        and turn_id in (select id from turns where thread_id = ${threadId} and status = 'running')`;
    await tx`
      update turns set message_ts = array_remove(message_ts, ${ts})
      where thread_id = ${threadId} and status = 'pending' and ${ts} = any(message_ts)`;
    await tx`
      update turns set status = 'cancelled', finished_at = now()
      where thread_id = ${threadId} and status = 'pending' and kind = 'user' and cardinality(message_ts) = 0`;
  });
}

/** Turns marked running in this thread. Only valid to call while holding the thread lock (then they are stale). */
export async function runningTurnIds(threadId: string): Promise<number[]> {
  const rows = await sql<{ id: number }[]>`select id::int as id from turns where thread_id = ${threadId} and status = 'running'`;
  return rows.map((r) => r.id);
}

/**
 * Native stop: drop the author's not-yet-started user turns in this thread, and the unconsumed inbox rows of their
 * running turn (so finishTurn doesn't turn them into a new turn). Synthesis turns are kept: they freeze the plan card.
 * Returns the cancelled turn ids.
 */
export async function dropPendingUserTurns(threadId: string, authorId: string): Promise<number[]> {
  return sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    const rows = await tx<{ id: number }[]>`
      update turns set status = 'cancelled', finished_at = now()
      where thread_id = ${threadId} and author_id = ${authorId} and kind = 'user' and status = 'pending'
      returning id::int as id`;
    await tx`
      update thread_inbox set consumed_at = now() where consumed_at is null
        and turn_id in (select id from turns where thread_id = ${threadId} and author_id = ${authorId} and status = 'running')`;
    return rows.map((r) => r.id);
  });
}
