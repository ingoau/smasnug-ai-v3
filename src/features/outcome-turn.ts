/**
 * Outcome turns: the agent hears back when a confirmation it asked for is resolved. send_message outside the thread
 * and spawn_coding_agent only propose (the user gets an ephemeral preview with buttons) and the agent's turn ends;
 * when the user clicks (Send / Cancel, Cancel on a launch), a definitive failure happens, or the preview expires, a
 * front turn runs in the pending row's thread with the requester as speaker and a system notice stating the outcome
 * as its input.
 *
 * It reuses the 'scheduled' turn kind (stored input in scheduled_turn_inputs, rendered by front.ts in place of new
 * messages) added for reminders: that kind already means "a turn not started by a user message, whose input is a
 * stored notice", and every path that cares (reply delivery, no coding agents from non-user turns, status) treats it
 * right. A dedicated kind would only have to be threaded through the same places with identical behaviour.
 *
 * Exactly once per pending row: the caller's status transition (a conditional update on the pending row) and the turn
 * insert commit in one transaction, so a double click, a retried job or expiry racing a click can only win once; a
 * unique index on (source, source_ref) is the backstop. Entry checks (pause, channel disabled, suspension) and a gone
 * thread skip the turn quietly; the transition still happens.
 *
 * A confirmation must not depend on the model: an outcome turn may carry a code-written `fallback` (e.g. "sent ✓
 * <link>") that front.ts posts when the turn ends with nothing visible or fails; outcome turns never get the generic
 * "couldn't come up with a reply" / error texts. If ensureThreadRun is lost after the commit, the pipeline's
 * recoverOrphanedTurns (src/pipeline/maintenance.ts, every 30 s) re-enqueues threads with old pending turns of any kind.
 */
import type { TransactionSql } from 'postgres';
import { appendEvent, parseThreadId } from '../core/events.js';
import { isThreadGone } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { ensureThreadRun } from '../pipeline/scheduler.js';
import { checkEntry } from './guard.js';
import { createScheduledTurnTx } from './schedule/deliver.js';

type Tx = TransactionSql<{}>;

/** `huddlefm`: DJ mode notices (grant answered, session ended, chatter; src/features/huddlefm/notices.ts). */
export type OutcomeSource = 'send' | 'coding_launch' | 'huddlefm';

/** Why no outcome turn may run for `speakerId` in `threadId` (null = ok). */
export async function outcomeSkipReason(threadId: string | null, speakerId: string): Promise<string | null> {
  if (!threadId) return 'thread_gone'; // retention removed the thread row (pending_sends.thread_id → null)
  const [row] = await sql<{ rootDeletedAt: Date | null }[]>`select root_deleted_at from threads where id = ${threadId}`;
  if (!row || row.rootDeletedAt) return 'thread_gone';
  const { channelId, threadTs } = parseThreadId(threadId);
  if (await isThreadGone(channelId, threadTs)) return 'thread_gone';
  // Not a new message: gated (pause, channel disable, suspension) but not counted.
  const entry = await checkEntry(speakerId, channelId, { countMessage: false });
  return entry.ok ? null : entry.reason;
}

export interface OutcomeResult {
  /** The transition won (this call resolved the pending row). */
  settled: boolean;
  /** The outcome turn, when one was created. */
  turnId: number | null;
  /** Why no turn was created although the transition won. */
  skipped: string | null;
}

/**
 * Resolve a pending confirmation and start the outcome turn with it. `transition` runs inside the transaction and
 * must be the conditional status update that makes this outcome final (true = it changed the row). Errors propagate
 * (nothing is committed, so the caller's retry path applies).
 */
export async function settleWithOutcome(o: {
  threadId: string | null;
  speakerId: string;
  source: OutcomeSource;
  sourceRef: string;
  input: string;
  /** The user just acted: status from the start, a reply is expected. */
  isMention: boolean;
  /** Posted by code if the turn ends with nothing visible or fails (null: nothing). */
  fallback?: string | null;
  /** Resolve without a turn (e.g. the user was already told privately); logged as the skip reason. */
  skip?: string;
  transition: (tx: Tx) => Promise<boolean>;
}): Promise<OutcomeResult> {
  let skipped = o.skip ?? (await outcomeSkipReason(o.threadId, o.speakerId));
  let turnId: number | null = null;
  const settled = await sql.begin(async (tx) => {
    if (!(await o.transition(tx))) return false;
    if (skipped || !o.threadId) return true;
    const [th] = await tx`select id from threads where id = ${o.threadId} for update`;
    if (!th) {
      skipped = 'thread_gone';
      return true;
    }
    const [dup] = await tx`select 1 from scheduled_turn_inputs where source = ${o.source} and source_ref = ${o.sourceRef}`;
    if (dup) {
      skipped = 'duplicate';
      return true;
    }
    turnId = await createScheduledTurnTx(tx, {
      threadId: o.threadId,
      ownerId: o.speakerId,
      source: o.source,
      sourceId: null,
      sourceRef: o.sourceRef,
      input: o.input,
      fallback: o.fallback ?? null,
      isMention: o.isMention,
      markAddressed: o.isMention,
    });
    return true;
  });
  if (!settled) return { settled: false, turnId: null, skipped: null };
  if (turnId != null) await ensureThreadRun(o.threadId!);
  if (o.threadId) {
    await appendEvent(o.threadId, 'confirmation_outcome', 'system', { source: o.source, ref: o.sourceRef, turnId, skipped }).catch(() => {});
  }
  if (skipped) log.info({ source: o.source, ref: o.sourceRef, skipped }, 'confirmation outcome: no turn');
  return { settled: true, turnId, skipped };
}
