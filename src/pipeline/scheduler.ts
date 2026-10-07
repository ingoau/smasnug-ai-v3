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
import { batchIsAddressed, batchNeedsGate, compareTs, type BatchReason } from './rules.js';
import { loadMessages } from './store.js';
import { addToBatch, hasPendingHumanInput } from './debounce.js';
import { appendEvent } from '../core/events.js';
import { redis } from '../core/redis.js';
import { limits } from '../config.js';
import { decideHold, pickNextTurn, yieldCutoff, type PendingTurn } from './turn-hold.js';

const TURN_COLS = sql`id::int as id, thread_id, author_id, kind, is_mention, addressed, gated, message_ts, card_id::int as card_id, status, phase`;

/** A message with the intake reason it was batched for (rules.ts BatchReason). */
export interface ReasonedTs {
  ts: string;
  reason: BatchReason;
}

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
  /** User turns: framed as talking with the bot without a mention (TurnRow.addressed). */
  addressed?: boolean;
  /** User turns: the relevance gate said yes (TurnRow.gated). */
  gated?: boolean;
}): Promise<number> {
  const id = await sql.begin(async (tx) => {
    await lockThread(tx, opts.threadId);
    if (opts.kind === 'user')
      return addToPendingTurnTx(tx, opts.threadId, opts.authorId, opts.messageTs ?? [], opts.isMention ?? false, { addressed: opts.addressed, gated: opts.gated });
    const [row] = await tx<{ id: number }[]>`
      insert into turns (thread_id, author_id, kind, is_mention, message_ts, card_id)
      values (${opts.threadId}, ${opts.authorId}, ${opts.kind}, ${opts.isMention ?? false}, ${opts.messageTs ?? []}::text[], ${opts.cardId ?? null})
      returning id::int as id`;
    return row!.id;
  });
  await ensureThreadRun(opts.threadId);
  return id;
}

/**
 * requestTurn for a non-user turn inside the caller's transaction, so the turn commits atomically with the caller's
 * own state change (fired reminders / watch notifications: exactly-once). Takes the thread row lock; the thread row
 * must exist. The caller calls ensureThreadRun after commit.
 */
export async function insertTurnTx(
  tx: Tx,
  opts: { threadId: string; authorId: string; kind: Exclude<TurnRow['kind'], 'user'>; isMention?: boolean; cardId?: number },
): Promise<number> {
  await lockThread(tx, opts.threadId);
  const [row] = await tx<{ id: number }[]>`
    insert into turns (thread_id, author_id, kind, is_mention, message_ts, card_id)
    values (${opts.threadId}, ${opts.authorId}, ${opts.kind}, ${opts.isMention ?? false}, '{}'::text[], ${opts.cardId ?? null})
    returning id::int as id`;
  return row!.id;
}

/** Append to the author's pending user turn, or create one. Caller holds the thread row lock. Flags only ever turn on. */
async function addToPendingTurnTx(
  tx: Tx,
  threadId: string,
  authorId: string,
  ts: string[],
  isMention: boolean,
  flags: { addressed?: boolean; gated?: boolean } = {},
): Promise<number> {
  const addressed = flags.addressed ?? false;
  const gated = flags.gated ?? false;
  const [pending] = await tx<{ id: number; messageTs: string[] }[]>`
    select id::int as id, message_ts from turns
    where thread_id = ${threadId} and author_id = ${authorId} and kind = 'user' and status = 'pending'
    order by id limit 1 for update`;
  if (pending) {
    await tx`update turns set message_ts = ${mergeTs(pending.messageTs, ts)}::text[], is_mention = is_mention or ${isMention},
               addressed = addressed or ${addressed}, gated = gated or ${gated}
             where id = ${pending.id}`;
    return pending.id;
  }
  const [row] = await tx<{ id: number }[]>`
    insert into turns (thread_id, author_id, kind, is_mention, addressed, gated, message_ts)
    values (${threadId}, ${authorId}, 'user', ${isMention}, ${addressed}, ${gated}, ${mergeTs([], ts)}::text[])
    returning id::int as id`;
  return row!.id;
}

export type ScheduleResult = { kind: 'inbox'; turnId: number } | { kind: 'turn'; turnId: number };

/**
 * If the thread's running turn belongs to the same author, is in phase 'tools' and no turn of theirs is already
 * waiting, push the messages into its inbox. Returns the running turn id, or null. `items` gives each message's
 * intake reason (kept on the inbox row for leftovers, see finishTurn); without it the rows are mention / direct.
 */
export async function pushToRunningTurn(threadId: string, authorId: string, ts: string[], isMention: boolean, items?: ReasonedTs[]): Promise<number | null> {
  const reasonOf = new Map(items?.map((i) => [i.ts, i.reason]));
  return sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    const [running] = await tx<{ id: number; authorId: string; phase: string | null; kind: string }[]>`
      select id::int as id, author_id, phase, kind from turns
      where thread_id = ${threadId} and status = 'running' order by id desc limit 1 for update`;
    if (!running || running.authorId !== authorId || running.phase !== 'tools' || running.kind !== 'user') return null;
    const [waiting] = await tx`select 1 from turns where thread_id = ${threadId} and author_id = ${authorId} and status = 'pending' limit 1`;
    if (waiting) return null; // keep order: the author's newer messages queue behind their waiting turn
    for (const t of ts) {
      await tx`insert into thread_inbox (turn_id, message_ts, is_mention, reason) values (${running.id}, ${t}, ${isMention}, ${reasonOf.get(t) ?? null})`;
    }
    return running.id;
  });
}

/** Debounced batch → inbox push into the author's running turn, or a (new or extended) pending turn + thread-run. */
export async function scheduleMessages(
  threadId: string,
  authorId: string,
  ts: string[],
  isMention: boolean,
  opts: { allowInbox?: boolean; addressed?: boolean; gated?: boolean; items?: ReasonedTs[] } = {},
): Promise<ScheduleResult> {
  if (opts.allowInbox !== false) {
    const turnId = await pushToRunningTurn(threadId, authorId, ts, isMention, opts.items);
    if (turnId != null) return { kind: 'inbox', turnId };
  }
  const turnId = await sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    return addToPendingTurnTx(tx, threadId, authorId, ts, isMention, { addressed: opts.addressed, gated: opts.gated });
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

// ---- turn hold / order for non-user turns (src/pipeline/turn-hold.ts) ----

/** Per non-user turn: `since` (first held, ms) and `cutoff` (its yield cutoff, once fixed). */
const holdKey = (turnId: number) => `turnhold:${turnId}`;
/** Set while a turn of this thread is held: the debounce fire then wakes the thread (wakeHeldTurn). */
const holdWakeKey = (threadId: string) => `turnhold:thread:${threadId}`;
const HOLD_STATE_TTL_MS = 60 * 60 * 1000;

async function getHoldState(turnId: number): Promise<{ since: number | null; cutoff: number | null }> {
  const h = await redis.hgetall(holdKey(turnId));
  return { since: h.since ? Number(h.since) : null, cutoff: h.cutoff ? Number(h.cutoff) : null };
}

/** Wake a thread whose turn is held for pending human input (called once a debounce fire is done with a batch). */
export async function wakeHeldTurn(threadId: string): Promise<void> {
  if (await redis.exists(holdWakeKey(threadId))) await ensureThreadRun(threadId);
}

export type ClaimResult = { kind: 'turn'; turn: TurnRow } | { kind: 'held'; turnId: number; retryInMs: number };

/**
 * The thread-run holder's claim: the next pending turn, or `held` when a non-user turn is next in line and a
 * person's newer message is still in debounce / at the gate (bounded by limits.turnHoldMaxMs; the caller retries
 * after `retryInMs`). Once a non-user turn stops waiting it fixes its yield cutoff: user turns queued behind it at
 * that moment run first (see turn-hold.ts). claimNextPending stays plain id order.
 */
export async function claimNextTurn(threadId: string, nowMs = Date.now()): Promise<ClaimResult | null> {
  const out = await sql.begin(async (tx) => {
    await lockThread(tx, threadId);
    const pending = await tx<PendingTurn[]>`
      select id::int as id, kind from turns where thread_id = ${threadId} and status = 'pending' order by id for update`;
    const head = pending[0];
    if (!head) return null;
    let cutoff: number | null = null;
    let held: { turnId: number; kind: string; waitedMs: number; timedOut: boolean } | null = null;
    if (head.kind !== 'user') {
      const state = await getHoldState(head.id);
      cutoff = state.cutoff;
      if (cutoff == null) {
        const d = decideHold({ pendingHuman: await hasPendingHumanInput(threadId), heldSinceMs: state.since, nowMs, turnHoldMaxMs: limits.turnHoldMaxMs, turnHoldPollMs: limits.turnHoldPollMs });
        if (d.hold) {
          await redis
            .multi()
            .hsetnx(holdKey(head.id), 'since', String(nowMs))
            .pexpire(holdKey(head.id), HOLD_STATE_TTL_MS)
            .set(holdWakeKey(threadId), String(head.id), 'PX', limits.turnHoldMaxMs + 10_000)
            .exec();
          return { kind: 'held' as const, turnId: head.id, retryInMs: d.retryInMs, first: state.since == null };
        }
        cutoff = yieldCutoff(pending);
        await redis.multi().hset(holdKey(head.id), 'cutoff', String(cutoff)).pexpire(holdKey(head.id), HOLD_STATE_TTL_MS).del(holdWakeKey(threadId)).exec();
        if (state.since != null) held = { turnId: head.id, kind: head.kind, waitedMs: d.waitedMs, timedOut: d.timedOut };
      }
    }
    const id = pickNextTurn(pending, cutoff)!;
    const [turn] = await tx<TurnRow[]>`
      update turns set status = 'running', phase = 'tools', started_at = now() where id = ${id} returning ${TURN_COLS}`;
    return { kind: 'turn' as const, turn: turn!, held, aheadOf: id !== head.id ? head.id : null };
  });
  if (!out) return null;
  if (out.kind === 'held') {
    if (out.first) await appendEvent(threadId, 'turn_held', 'system', { turnId: out.turnId, maxMs: limits.turnHoldMaxMs }).catch(() => {});
    return { kind: 'held', turnId: out.turnId, retryInMs: out.retryInMs };
  }
  if (out.held) await appendEvent(threadId, 'turn_hold_ended', 'system', out.held).catch(() => {});
  if (out.aheadOf != null) await appendEvent(threadId, 'turn_yielded', 'system', { turnId: out.aheadOf, to: out.turn.id }).catch(() => {});
  return { kind: 'turn', turn: out.turn };
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
 * The intake reasons of leftover inbox rows. Rows from before reasons were stored count as what they ran as then
 * (mention, or a direct follow-up).
 */
export function leftoverReasons(rows: { isMention: boolean; reason: string | null }[]): BatchReason[] {
  return rows.map((r) => (r.reason as BatchReason | null) ?? (r.isMention ? 'mention' : 'direct'));
}

/**
 * Finish a running turn. Inbox rows it never drained: if every one of them needed the gate (rules.ts batchNeedsGate:
 * pushed into the running turn before any gate ran), they go back into the author's debounce batch with their
 * reasons, so the gate decides on them like on any other message; otherwise (a mention, DM, button press or answer
 * to the bot is among them) they move into a new pending turn for the same author (the holder loop picks it up
 * next). Returns the id of that follow-up turn, if any.
 */
export async function finishTurn(turnId: number, status: 'done' | 'error' | 'cancelled'): Promise<number | null> {
  const out = await sql.begin(async (tx) => {
    const [t] = await tx<{ threadId: string }[]>`select thread_id from turns where id = ${turnId}`;
    if (!t) return null;
    await lockThread(tx, t.threadId);
    const [turn] = await tx<{ authorId: string; status: string }[]>`select author_id, status from turns where id = ${turnId} for update`;
    if (!turn || turn.status !== 'running') return null;
    await tx`update turns set status = ${status}, phase = null, finished_at = now() where id = ${turnId}`;
    const left = await tx<{ messageTs: string; isMention: boolean; reason: string | null }[]>`
      update thread_inbox set consumed_at = now() where turn_id = ${turnId} and consumed_at is null returning message_ts, is_mention, reason`;
    if (left.length === 0) return null;
    const reasons = leftoverReasons(left);
    const items = left.map((r, i) => ({ ts: r.messageTs, reason: reasons[i]! }));
    if (batchNeedsGate(reasons)) return { threadId: t.threadId, authorId: turn.authorId, regate: items, followUp: null };
    const isMention = left.some((r) => r.isMention);
    const followUp = await addToPendingTurnTx(
      tx,
      t.threadId,
      turn.authorId,
      items.map((i) => i.ts),
      isMention,
      { addressed: !isMention && batchIsAddressed(reasons) },
    );
    return { threadId: t.threadId, authorId: turn.authorId, regate: null, followUp };
  });
  if (!out) return null;
  if (out.regate) {
    for (const i of out.regate) await addToBatch(out.threadId, out.authorId, i.ts, i.reason);
    await appendEvent(out.threadId, 'inbox_regated', 'system', { turnId, messageTs: out.regate.map((i) => i.ts) }).catch(() => {});
  }
  return out.followUp;
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
