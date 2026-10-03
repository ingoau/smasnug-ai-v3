/**
 * Message intake: storage, engagement bookkeeping, deterministic rules, entry guard, then into the debounce batch.
 * The relevance gate runs later, once per debounced batch (see fire.ts).
 */
import { appendEvent, threadIdOf } from '../core/events.js';
import { getBotIdentity, slackCall } from '../core/slack.js';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { markMessage } from '../core/timing.js';
import { addToBatch, removeFromBatch } from './debounce.js';
import { guardEntry } from './entry.js';
import { decide, isStopMessage, mentionFacts, NEW_MESSAGE_SUBTYPES, shouldDisengage, threadRootTs } from './rules.js';
import { removeMessageFromTurns } from './scheduler.js';
import { showIntakeStatus } from './session-status.js';
import { applyDelete, applyEdit, getThread, insertTombstone, isBotMessage, isTwoPartyThread, storeMessage, upsertThread, type SlackMessage, type ThreadRow } from './store.js';

export const RATE_LIMITED_TEXT = "You're sending me a lot of messages — give me a bit and try again.";

interface MessageEvent extends SlackMessage {
  type: 'message';
  channel: string;
  channel_type?: 'im' | 'mpim' | 'channel' | 'group';
  hidden?: boolean;
  message?: SlackMessage;
  previous_message?: SlackMessage;
  deleted_ts?: string;
}

export async function handleMessageEvent(ev: MessageEvent) {
  if (!ev.channel) return;
  if (ev.subtype === 'message_changed') return handleEdit(ev);
  if (ev.subtype === 'message_deleted') return handleDelete(ev.channel, ev.deleted_ts, ev.previous_message);
  if (ev.hidden || !NEW_MESSAGE_SUBTYPES.has(ev.subtype)) return;
  return handleNewMessage(ev);
}

/** Mark the bot as addressed in a thread: engaged, counters reset. */
async function markAddressed(threadId: string, engaged: boolean) {
  await sql`update threads set engaged = ${engaged}, last_addressed_at = now(), messages_since_addressed = 0, last_activity_at = now()
            where id = ${threadId}`;
}

export async function disengage(threadId: string, reason: string, actor: string | null) {
  await sql`update threads set engaged = false where id = ${threadId} and engaged`;
  await appendEvent(threadId, 'disengaged', actor, { reason });
}

async function handleNewMessage(ev: MessageEvent) {
  const bot = await getBotIdentity();
  const channelId = ev.channel;
  const isDm = ev.channel_type === 'im';
  const isBot = isBotMessage(ev) || ev.user === bot.userId;
  const threadId = threadIdOf(channelId, threadRootTs(ev));
  const text = ev.text ?? '';
  const { mentionsBot, mentionsOthers } = isBot ? { mentionsBot: false, mentionsOthers: false } : mentionFacts(text, bot.userId);

  let thread = await getThread(threadId);
  if (!thread && !isBot && (isDm || mentionsBot)) {
    thread = await upsertThread({ id: threadId, channelId, threadTs: threadRootTs(ev), isDm });
  }
  // Threads the bot was never part of: not stored (the context module backfills what it needs).
  if (!thread) return;

  const { deleted } = await storeMessage(channelId, threadId, ev);
  if (deleted) return; // deleted before we got to process it
  await appendEvent(threadId, 'message', ev.user ?? (ev.bot_id ? `bot:${ev.bot_id}` : null), {
    ts: ev.ts,
    ...(ev.subtype ? { subtype: ev.subtype } : {}),
    ...(ev.files?.length ? { files: ev.files.length } : {}),
    ...(isBot ? { bot: true } : {}),
  });
  if (isBot || !ev.user) return; // bots never start a turn

  const authorId = ev.user;
  const isStop = isStopMessage(text);
  let disengageDue = false;
  if (isDm || mentionsBot) {
    await markAddressed(threadId, true);
  } else if (thread.engaged) {
    disengageDue = await countUnaddressed(thread);
  }
  const twoParty = thread.engaged && !isDm && !mentionsBot && !mentionsOthers ? await isTwoPartyThread(thread, authorId) : false;

  const decision = decide({ isBot, isDm, mentionsBot, mentionsOthers, engaged: isDm || thread.engaged, disengageDue, twoParty, isStop });
  log.debug({ threadId, ts: ev.ts, decision }, 'message decision');
  if (decision.action === 'ignore') {
    if (decision.reason === 'disengaged') await disengage(threadId, 'idle', null);
    return;
  }
  if (decision.disengage) {
    await disengage(threadId, 'stop', authorId);
    await sql`update threads set last_addressed_at = now(), messages_since_addressed = 0 where id = ${threadId}`;
  } else if (decision.reason === 'direct') {
    await markAddressed(threadId, true);
  }

  const entry = await guardEntry(authorId, channelId);
  if (!entry.ok) {
    if (entry.reason === 'rate_limited' && (isDm || mentionsBot)) {
      await slackCall(
        'chat.postEphemeral',
        { channel: channelId, user: authorId, text: RATE_LIMITED_TEXT, ...(ev.thread_ts ? { thread_ts: ev.thread_ts } : {}) },
        { idempotencyKey: `rate-limited:${channelId}:${ev.ts}` },
      ).catch((err) => log.warn({ err }, 'rate-limit ephemeral failed'));
    }
    return;
  }

  // DMs and mentions get the status indicator right away, before the debounce window (fire-and-forget).
  if (decision.reason === 'dm' || decision.reason === 'mention') showIntakeStatus(threadId, authorId, ev.ts);
  await addToBatch(threadId, authorId, ev.ts, decision.reason);
  markMessage(channelId, ev.ts, { debounce_scheduled: Date.now() });
}

/** Count an unaddressed human message; returns true when the thread should disengage. */
async function countUnaddressed(thread: ThreadRow): Promise<boolean> {
  const [row] = await sql<{ messagesSinceAddressed: number; lastAddressedAt: Date | null }[]>`
    update threads set messages_since_addressed = messages_since_addressed + 1, last_activity_at = now()
    where id = ${thread.id} returning messages_since_addressed, last_addressed_at`;
  if (!row) return false;
  return shouldDisengage(row, new Date(), { afterMessages: limits.disengageAfterMessages, afterMs: limits.disengageAfterMs });
}

async function handleEdit(ev: MessageEvent) {
  const msg = ev.message;
  if (!msg?.ts) return;
  // Deleting a thread parent that has replies turns it into a tombstone.
  if (msg.subtype === 'tombstone') return handleDelete(ev.channel, msg.ts, ev.previous_message ?? msg);
  let threadId = (await applyEdit(ev.channel, msg))?.threadId ?? null;
  if (!threadId && msg.edited) {
    // Edit processed before the original message (parallel workers): store the edited version for threads the
    // original will engage or already has. The original's own event still triggers the turn (and keeps this text).
    const candidate = threadIdOf(ev.channel, threadRootTs(msg));
    let known = Boolean(await getThread(candidate));
    if (!known && !isBotMessage(msg) && msg.user) {
      const bot = await getBotIdentity();
      const isDm = ev.channel_type === 'im';
      if (isDm || mentionFacts(msg.text ?? '', bot.userId).mentionsBot) {
        await upsertThread({ id: candidate, channelId: ev.channel, threadTs: threadRootTs(msg), isDm });
        known = true;
      }
    }
    if (known) {
      await storeMessage(ev.channel, candidate, msg);
      threadId = candidate;
    }
  }
  if (threadId && msg.edited) await appendEvent(threadId, 'message_edited', msg.user ?? null, { ts: msg.ts });
  // During a debounce window the batch only holds the ts; the turn reads the edited text from the DB.
}

async function handleDelete(channelId: string, ts: string | undefined, prev?: SlackMessage) {
  if (!ts) return;
  const row = await applyDelete(channelId, ts);
  let threadId = row?.threadId ?? null;
  if (!threadId && prev) {
    const candidate = threadIdOf(channelId, prev.thread_ts ?? ts);
    if (await getThread(candidate)) threadId = candidate;
  }
  if (!threadId) return;
  if (!row) await insertTombstone(channelId, ts, threadId, prev?.user ?? null);
  await appendEvent(threadId, 'message_deleted', row?.userId ?? prev?.user ?? null, { ts });
  const authorId = row?.userId ?? prev?.user;
  if (authorId) await removeFromBatch(threadId, authorId, ts);
  await removeMessageFromTurns(threadId, ts);
}
