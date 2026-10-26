/**
 * Privacy consent in the pipeline (policy + store: src/features/privacy.ts). A DM or mention from a user who hasn't
 * agreed to the current policy doesn't start a turn: the message is held (`privacy_held`) and the user gets an
 * ephemeral prompt (at most one per conversation per PROMPT_THROTTLE_S). "I agree" records the agreement and replays
 * the held messages (those under HOLD_REPLAY_MS old) as if they had just arrived. Other batch reasons (gated
 * follow-ups, answers to the bot) from such users are dropped silently. Their messages are still stored as context.
 */
import type { ActionContext } from '../core/actions.js';
import { getBotIdentity, slackCall } from '../core/slack.js';
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { PROMPT_TEXT, promptBlocks, recordAgreement } from '../features/privacy.js';
import { ephemeral } from '../features/util.js';
import { addToBatch } from './debounce.js';
import { redirectGroupPing } from './guideline-actions.js';
import type { BatchReason } from './rules.js';
import { showIntakeStatus } from './session-status.js';
import type { SlackMessage } from './store.js';

const PROMPT_THROTTLE_S = 10 * 60;
export const HOLD_REPLAY_MS = 60 * 60 * 1000;

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
  if (item) await sql`insert into privacy_held (user_id, item) values (${userId}, ${sql.json(item as any)})`;
  log.info({ userId, channelId, held: item?.kind ?? null }, 'privacy consent needed');
  const first = await redis.set(`privacy:prompted:${userId}:${conversation}`, '1', 'EX', PROMPT_THROTTLE_S, 'NX');
  if (!first) return;
  await slackCall(
    'chat.postEphemeral',
    { channel: channelId, user: userId, text: PROMPT_TEXT, blocks: promptBlocks(), ...(promptThreadTs ? { thread_ts: promptThreadTs } : {}) },
    { idempotencyKey: `privacy-prompt:${channelId}:${messageTs}` },
  ).catch((err) => log.warn({ err }, 'privacy prompt failed'));
}

/** "I agree": record it, replace the prompt, replay the held messages. */
export async function handlePrivacyAgree(ctx: ActionContext): Promise<void> {
  await recordAgreement(ctx.userId);
  const held = await sql<{ item: HeldItem; createdAt: Date }[]>`delete from privacy_held where user_id = ${ctx.userId} returning item, created_at`;
  const replay = held.filter((h) => Date.now() - new Date(h.createdAt).getTime() < HOLD_REPLAY_MS).map((h) => h.item);
  log.info({ userId: ctx.userId, replayed: replay.length, dropped: held.length - replay.length }, 'privacy policy agreed');
  await ephemeral(ctx, replay.length ? 'Thanks! Getting to your message now.' : 'Thanks! You can ask me anything now.', { replace: true });
  const bot = replay.some((i) => i.kind === 'redirect') ? await getBotIdentity() : null;
  for (const item of replay) {
    try {
      if (item.kind === 'redirect') {
        await redirectGroupPing(item.event, bot!);
      } else {
        if (item.reason === 'dm' || item.reason === 'mention') showIntakeStatus(item.threadId, ctx.userId, item.ts);
        await addToBatch(item.threadId, ctx.userId, item.ts, item.reason);
      }
    } catch (err) {
      log.warn({ err, userId: ctx.userId }, 'replaying a held message failed');
    }
  }
}
