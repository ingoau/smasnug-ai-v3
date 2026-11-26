/**
 * Outcome turns: the agent hears back when a confirmation it asked for is resolved. send_message outside the thread
 * only proposes (the user gets an ephemeral preview with buttons) and the agent's turn ends;
 * when the user clicks (Send / Cancel), a definitive failure happens, or the preview expires, a
 * front turn runs in the pending row's thread with the requester as speaker and a system notice stating the outcome
 * as its input.
 *
 * It reuses the 'scheduled' turn kind (stored input in scheduled_turn_inputs, rendered by front.ts in place of new
 * messages) added for reminders: that kind already means "a turn not started by a user message, whose input is a
 * stored notice", and every path that cares (reply delivery, vault trust, status) treats it
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
/** `button_action`: an action button's bound call failed (src/agent/reply-quiet.ts). */
/** `preview`: a live preview deployed (or failed) after the subagent's run ended (src/sandbox/preview/flow.ts). */
/** `approval`: an action its owner approved (or denied) on a vault card (src/features/vault/approvals.ts). */
export type OutcomeSource = 'send' | 'huddlefm' | 'button_action' | 'preview' | 'approval';

/** Sources whose turns carry a code-written fallback (front.ts posts it when the turn shows nothing). */
export const OUTCOME_SOURCES: readonly string[] = ['send', 'huddlefm', 'button_action', 'preview', 'approval'];

/**
 * A source may post its fallback as a message of its own (e.g. with buttons) instead of the plain text: the renderer
 * gets the turn's source_ref and the fallback text and returns the message, or null for the plain text.
 */
type FallbackRenderer = (sourceRef: string | null, fallback: string) => Promise<{ text: string; blocks: unknown[]; onPosted?: (ts: string) => Promise<void> } | null>;
const fallbackRenderers = new Map<string, FallbackRenderer>();

export function registerOutcomeFallback(source: OutcomeSource, render: FallbackRenderer): void {
  fallbackRenderers.set(source, render);
}

/**
 * A source may find, when its outcome turn finally runs, that the notice is moot (e.g. a live preview someone already
 * posted): the check returns the input to use instead (a "do nothing" notice), or null to keep the stored one. A moot
 * turn posts no fallback.
 */
type ObsoleteCheck = (sourceRef: string | null) => Promise<string | null>;
const obsoleteChecks = new Map<string, ObsoleteCheck>();

export function registerOutcomeObsolete(source: OutcomeSource, check: ObsoleteCheck): void {
  obsoleteChecks.set(source, check);
}

export async function outcomeObsolete(source: string, sourceRef: string | null): Promise<string | null> {
  const c = obsoleteChecks.get(source);
  return c ? c(sourceRef).catch((err) => (log.warn({ err, source }, 'outcome obsolete check failed'), null)) : null;
}

export async function renderOutcomeFallback(source: string, sourceRef: string | null, fallback: string): ReturnType<FallbackRenderer> {
  const r = fallbackRenderers.get(source);
  return r ? r(sourceRef, fallback).catch((err) => (log.warn({ err, source }, 'outcome fallback renderer failed'), null)) : null;
}

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
