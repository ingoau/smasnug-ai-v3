/**
 * Shared delivery for fired reminders and watch notifications: entry checks at fire/check time, where to run the
 * turn (the original thread, or a DM to the owner when the thread's root is gone), and the scheduled turn itself.
 */
import type { TransactionSql } from 'postgres';
import { appendEvent, parseThreadId, threadIdOf } from '../../core/events.js';
import { isThreadGone, slackCall, slackErrorCode } from '../../core/slack.js';
import { getUserInfo } from '../../context/users.js';
import { sql } from '../../db/index.js';
import { insertTurnTx } from '../../pipeline/scheduler.js';
import { upsertThread } from '../../pipeline/store.js';
import { checkEntry } from '../guard.js';

type Tx = TransactionSql<{}>;

export type SkipReason = 'paused' | 'channel_disabled' | 'suspended' | 'rate_limited' | 'bot_removed' | 'channel_archived' | 'owner_gone';

/**
 * Entry rules when a reminder fires or a watch is checked: global pause, channel disable, owner suspension (guard
 * checkEntry, not counted as a message), owner deactivated, and the bot still being in the (non-DM) channel. Null = ok.
 * Unexpected Slack errors throw (the caller retries later).
 */
export async function scheduleEntryCheck(ownerId: string, channelId: string): Promise<SkipReason | null> {
  const entry = await checkEntry(ownerId, channelId, { countMessage: false });
  if (!entry.ok) return entry.reason;
  const user = await getUserInfo(ownerId);
  if (user?.deleted) return 'owner_gone';
  if (channelId.startsWith('D')) return null;
  // is_member: "whether the … bot user … associated with the token making the API call is itself a member"
  // (https://docs.slack.dev/reference/objects/conversation-object); is_archived per conversations.info.
  let info: any;
  try {
    info = (await slackCall<any>('conversations.info', { channel: channelId })).channel;
  } catch (err) {
    if (slackErrorCode(err) === 'channel_not_found') return 'bot_removed';
    throw err;
  }
  if (info?.is_archived) return 'channel_archived';
  if (info?.is_member === false) return 'bot_removed';
  return null;
}

/**
 * Root message still there, for a thread whose row retention already deleted (no root_deleted_at / gone key left).
 * conversations.replies: `thread_not_found` or a tombstone/different first message means the root is gone.
 * https://docs.slack.dev/reference/methods/conversations.replies
 */
async function rootMissing(channelId: string, threadTs: string): Promise<boolean> {
  try {
    const res = await slackCall<any>('conversations.replies', { channel: channelId, ts: threadTs, limit: 1 });
    const first = res.messages?.[0];
    // The fake answers with no messages; treat "nothing returned" as present (only explicit signals mean gone).
    if (!first) return false;
    return first.ts !== threadTs || first.subtype === 'tombstone';
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === 'thread_not_found' || code === 'message_not_found') return true;
    throw err;
  }
}

export interface Target {
  threadId: string;
  /** True when the turn runs in a DM thread with the owner (the original thread is gone, or can't be used). */
  fallback: boolean;
}

/** Reasons the original channel can't be used although the owner may still be reached by DM. */
const CHANNEL_UNAVAILABLE: ReadonlySet<SkipReason> = new Set(['channel_disabled', 'bot_removed', 'channel_archived']);

/**
 * Where a fired reminder runs, with the entry checks applied to the channel actually used. Pause, suspension and a
 * deactivated owner skip it. A disabled channel, a channel the bot left or an archived one don't: the reminder goes
 * to a DM thread with the owner instead (a one-shot reminder would otherwise be lost for good), as when the thread
 * root is gone. A DM target is then checked again against the DM channel (e.g. suspension, which a disabled channel
 * hides in checkEntry's order).
 */
export async function resolveDelivery(opts: {
  ownerId: string;
  threadId: string;
  channelId: string;
  idempotencyKey: string;
  rootText: (why: 'gone' | 'unavailable') => string;
}): Promise<{ skip: SkipReason } | { target: Target; why: 'gone' | 'unavailable' | null }> {
  const reason = await scheduleEntryCheck(opts.ownerId, opts.channelId);
  if (reason && !CHANNEL_UNAVAILABLE.has(reason)) return { skip: reason };
  const forceDm = reason != null;
  const target = await resolveTarget({
    ownerId: opts.ownerId,
    threadId: opts.threadId,
    idempotencyKey: opts.idempotencyKey,
    rootText: opts.rootText(forceDm ? 'unavailable' : 'gone'),
    forceDm,
  });
  if (target.fallback) {
    const dmReason = await scheduleEntryCheck(opts.ownerId, parseThreadId(target.threadId).channelId);
    if (dmReason) return { skip: dmReason };
  }
  return { target, why: target.fallback ? (forceDm ? 'unavailable' : 'gone') : null };
}

/**
 * Where the scheduled turn runs. The original thread when it can still be posted to (its row is recreated if
 * retention removed it); otherwise a new DM thread with the owner, rooted at a short bot message (idempotent on
 * `idempotencyKey`, so a retried fire reuses it).
 */
export async function resolveTarget(opts: { ownerId: string; threadId: string; idempotencyKey: string; rootText: string; forceDm?: boolean }): Promise<Target> {
  const { channelId, threadTs } = parseThreadId(opts.threadId);
  if (!opts.forceDm) {
    const [row] = await sql<{ rootDeletedAt: Date | null }[]>`select root_deleted_at from threads where id = ${opts.threadId}`;
    let gone = Boolean(row?.rootDeletedAt) || (await isThreadGone(channelId, threadTs));
    if (!row && !gone) gone = await rootMissing(channelId, threadTs);
    if (!gone) {
      if (!row) await upsertThread({ id: opts.threadId, channelId, threadTs, isDm: channelId.startsWith('D') });
      return { threadId: opts.threadId, fallback: false };
    }
  }
  const open = await slackCall<any>('conversations.open', { users: opts.ownerId });
  const dm: string | undefined = open.channel?.id;
  if (!dm) throw new Error('conversations.open returned no channel');
  const posted = await slackCall<any>('chat.postMessage', { channel: dm, text: opts.rootText, unfurl_links: false }, { idempotencyKey: opts.idempotencyKey });
  const ts: string | undefined = posted.ts ?? posted.message?.ts;
  if (!ts) throw new Error('DM fallback post returned no ts');
  const threadId = threadIdOf(dm, ts);
  await upsertThread({ id: threadId, channelId: dm, threadTs: ts, isDm: true });
  return { threadId, fallback: true };
}

/**
 * Inside the caller's transaction: a 'scheduled' turn for the owner with its input, and the thread marked addressed
 * (the owner is being pinged, so their follow-ups should reach the bot). The caller calls ensureThreadRun after commit.
 */
export async function createScheduledTurnTx(
  tx: Tx,
  opts: {
    threadId: string;
    ownerId: string;
    source: 'reminder' | 'watch' | 'send' | 'coding_launch' | 'huddlefm';
    /** reminder / watch id; outcome turns use `sourceRef` (a uuid) instead. */
    sourceId: number | null;
    sourceRef?: string;
    input: string;
    /** Outcome turns: posted by code when the turn ends with nothing visible or fails (src/features/outcome-turn.ts). */
    fallback?: string | null;
    isMention: boolean;
    /** Default true. False: only bump last_activity_at (e.g. an expired confirmation nobody acted on). */
    markAddressed?: boolean;
  },
): Promise<number> {
  const turnId = await insertTurnTx(tx, { threadId: opts.threadId, authorId: opts.ownerId, kind: 'scheduled', isMention: opts.isMention });
  await tx`insert into scheduled_turn_inputs (turn_id, source, source_id, source_ref, input, fallback)
           values (${turnId}, ${opts.source}, ${opts.sourceId}, ${opts.sourceRef ?? null}, ${opts.input}, ${opts.fallback ?? null})`;
  if (opts.markAddressed === false) await tx`update threads set last_activity_at = now() where id = ${opts.threadId}`;
  else
    await tx`update threads set engaged = true, last_addressed_at = now(), messages_since_addressed = 0, last_activity_at = now()
             where id = ${opts.threadId}`;
  return turnId;
}

/** The input of a scheduled turn (front agent: rendered in place of new messages), and an outcome turn's fallback. */
export async function scheduledTurnInput(turnId: number): Promise<{ source: string; input: string; fallback: string | null } | null> {
  const [row] = await sql<{ source: string; input: string; fallback: string | null }[]>`
    select source, input, fallback from scheduled_turn_inputs where turn_id = ${turnId}`;
  return row ?? null;
}

export async function logScheduled(threadId: string, type: string, actor: string, payload: object) {
  await appendEvent(threadId, type, actor, payload).catch(() => {});
}
