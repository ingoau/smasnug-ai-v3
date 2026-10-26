/**
 * Privacy consent in the pipeline (policy + store: src/features/privacy.ts). A DM or mention from a user who hasn't
 * agreed to the current policy doesn't start a turn: the message is held (`privacy_held`) and the user gets an
 * ephemeral prompt (at most one per conversation per PROMPT_THROTTLE_S). "I agree" records the agreement and replays
 * the held messages (those under HOLD_REPLAY_MS old) as if they had just arrived. Other batch reasons (gated
 * follow-ups, answers to the bot) from such users are dropped silently. Their messages are still stored as context.
 * A held message deleted (or edited to `##`) in Slack is dropped (intake calls dropHeldMessage).
 */
import type { ActionContext } from '../core/actions.js';
import { getBotIdentity, slackCall } from '../core/slack.js';
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { hasAgreed, privacyPolicy, PROMPT_TEXT, promptBlocks, recordAgreement } from '../features/privacy.js';
import { ephemeral, respond } from '../features/util.js';
import { addToBatch } from './debounce.js';
import { redirectGroupPing } from './guideline-actions.js';
import type { BatchReason } from './rules.js';
import { showIntakeStatus } from './session-status.js';
import type { SlackMessage } from './store.js';

const PROMPT_THROTTLE_S = 10 * 60;
export const HOLD_REPLAY_MS = 60 * 60 * 1000;
const CLAIM_STALE_S = 5 * 60;

/** What to replay after agreement: a debounce batch entry, or a group ping still to be redirected. */
export type HeldItem =
  | { kind: 'batch'; threadId: string; ts: string; reason: BatchReason }
  | { kind: 'redirect'; event: SlackMessage & { channel: string; user: string } };

/**
 * Hold `item` (if any) and prompt the user, in `promptThreadTs`'s thread or at the channel / DM root. The prompt is
 * keyed on the triggering message, and repeated in the same `conversation` (a thread id, or a DM channel, whose
 * top-level messages each start a thread) at most once per PROMPT_THROTTLE_S.
 */
export async function holdForConsent(opts: {
  userId: string;
  channelId: string;
  conversation: string;
  promptThreadTs?: string;
  messageTs: string;
  item?: HeldItem;
}): Promise<void> {
  const { userId, channelId, conversation, promptThreadTs, messageTs, item } = opts;
  if (item) {
    await sql`insert into privacy_held (user_id, item) values (${userId}, ${sql.json(item as any)})`;
    // They may have agreed (on another worker) between the caller's check and this insert: that replay ran before
    // the row existed, so replay it now instead of leaving it held forever.
    if (await hasAgreed(userId)) {
      await replayHeld(userId);
      return;
    }
  }
  log.info({ userId, channelId, held: item?.kind ?? null }, 'privacy consent needed');
  const first = await redis.set(`privacy:prompted:${userId}:${conversation}`, '1', 'EX', PROMPT_THROTTLE_S, 'NX');
  if (!first) return;
  await slackCall(
    'chat.postEphemeral',
    { channel: channelId, user: userId, text: PROMPT_TEXT, blocks: promptBlocks(), ...(promptThreadTs ? { thread_ts: promptThreadTs } : {}) },
    { idempotencyKey: `privacy-prompt:${channelId}:${messageTs}` },
  ).catch((err) => log.warn({ err }, 'privacy prompt failed'));
}

/** A held message was deleted, or edited to `##`, in Slack: never replay it. */
export async function dropHeldMessage(channelId: string, ts: string): Promise<void> {
  await sql`delete from privacy_held
            where (item->>'kind' = 'redirect' and item->'event'->>'channel' = ${channelId} and item->'event'->>'ts' = ${ts})
               or (item->>'kind' = 'batch' and item->>'ts' = ${ts} and split_part(item->>'threadId', ':', 1) = ${channelId})`;
}

/** A held group ping was edited in Slack: replay the edited text. */
export async function updateHeldMessage(channelId: string, msg: SlackMessage): Promise<void> {
  await sql`update privacy_held set item = jsonb_set(item, '{event}', (item->'event') || ${sql.json(msg as any)}::jsonb)
            where item->>'kind' = 'redirect' and item->'event'->>'channel' = ${channelId} and item->'event'->>'ts' = ${msg.ts}`;
}

/** "I agree": record it (only for the version the prompt showed), replace the prompt, replay the held messages. */
export async function handlePrivacyAgree(ctx: ActionContext): Promise<void> {
  const { version } = privacyPolicy();
  if (ctx.value && ctx.value !== version) {
    // The policy changed since this prompt was posted: show the new one instead of recording consent to it unseen.
    // In a thread, response_url posts land at the channel root, so the new prompt goes in with chat.postEphemeral.
    await ephemeral(ctx, 'The privacy policy changed since that message. Here is the current one.', { replace: true });
    const threadTs = ctx.threadTs && ctx.threadTs !== ctx.messageTs ? ctx.threadTs : undefined;
    if (ctx.channelId && threadTs) {
      await slackCall('chat.postEphemeral', { channel: ctx.channelId, user: ctx.userId, thread_ts: threadTs, text: PROMPT_TEXT, blocks: promptBlocks() }).catch((err) =>
        log.warn({ err }, 'privacy re-prompt failed'),
      );
    } else {
      await respond(ctx.responseUrl, { response_type: 'ephemeral', replace_original: false, text: PROMPT_TEXT, blocks: promptBlocks() });
    }
    return;
  }
  await recordAgreement(ctx.userId);
  const n = await sql<{ n: number }[]>`select count(*)::int as n from privacy_held
                                       where user_id = ${ctx.userId} and created_at > now() - ${HOLD_REPLAY_MS / 1000} * interval '1 second'`;
  await ephemeral(ctx, n[0]!.n ? 'Thanks! Getting to your message now.' : 'Thanks! You can ask me anything now.', { replace: true });
  await replayHeld(ctx.userId);
}

/**
 * Replay a user's held messages, oldest first. Each row is claimed (claimed_at, so a concurrent replay skips it), then
 * replayed, then deleted: a crash or error leaves it claimed, and the `pipeline:privacy-replay` maintenance task
 * (retryStaleReplays) picks it up once the claim is CLAIM_STALE_S old. Replaying one twice is harmless: the batch is
 * keyed by ts and the redirect post is idempotent. Rows over HOLD_REPLAY_MS old are deleted without replay.
 */
async function replayHeld(userId: string): Promise<void> {
  const rows = await sql<{ id: string; item: HeldItem; createdAt: Date }[]>`
    update privacy_held set claimed_at = now()
    where user_id = ${userId} and (claimed_at is null or claimed_at < now() - ${CLAIM_STALE_S} * interval '1 second')
    returning id, item, created_at`;
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  let replayed = 0;
  for (const row of rows) {
    if (Date.now() - new Date(row.createdAt).getTime() < HOLD_REPLAY_MS) {
      try {
        await replayItem(userId, row.item);
        replayed++;
      } catch (err) {
        log.warn({ err, userId }, 'replaying a held message failed');
        continue;
      }
    }
    await sql`delete from privacy_held where id = ${row.id}`;
  }
  log.info({ userId, replayed, claimed: rows.length }, 'privacy: held messages replayed');
}

async function replayItem(userId: string, item: HeldItem): Promise<void> {
  if (item.kind === 'redirect') {
    await redirectGroupPing(item.event, await getBotIdentity(), { replay: true });
    return;
  }
  if (item.reason === 'dm' || item.reason === 'mention') showIntakeStatus(item.threadId, userId, item.ts);
  await addToBatch(item.threadId, userId, item.ts, item.reason);
}

/** Maintenance: retry replays left claimed by an error or a crash (still young enough to answer). */
export async function retryStaleReplays(): Promise<void> {
  const users = await sql<{ userId: string }[]>`
    select distinct user_id from privacy_held
    where claimed_at < now() - ${CLAIM_STALE_S} * interval '1 second' and created_at > now() - ${HOLD_REPLAY_MS / 1000} * interval '1 second'`;
  for (const { userId } of users) await replayHeld(userId).catch((err) => log.warn({ err, userId }, 'retrying a held replay failed'));
}
