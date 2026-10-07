/**
 * Message intake: storage, engagement bookkeeping, deterministic rules, entry guard, then into the debounce batch.
 * The relevance gate runs later, once per debounced batch (see fire.ts).
 */
import { appendEvent, parseThreadId, threadIdOf } from '../core/events.js';
import { getBotIdentity, isChannelReadOnly, markThreadGone, slackCall } from '../core/slack.js';
import { cancelThreadRuns } from '../agent/subagents.js';
import { rehomeCodingAgents } from '../agent/cursor/agents.js';
import { requestThreadStop } from './stop.js';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { markMessage } from '../core/timing.js';
import { addToBatch, removeFromBatch } from './debounce.js';
import { guardEntry } from './entry.js';
import { handleBangStop, redirectGroupPing } from './guideline-actions.js';
import { hasQuietPrefix, isBangStop, isHiddenMessage, shouldRedirectGroupPing } from './guidelines.js';
import { answersOtherOffer, decide, isSlackbotUser, mentionFacts, NEW_MESSAGE_SUBTYPES, shouldDisengage, threadRootTs } from './rules.js';
import { isBotPeerDm } from './dm-peer.js';
import { removeMessageFromTurns } from './scheduler.js';
import { handleHuddleFmMessage, isFromHuddleFm } from '../features/huddlefm/inbound.js';
import { showIntakeStatus } from './session-status.js';
import {
  applyDelete,
  applyEdit,
  consumeAwaitedReply,
  getThread,
  insertTombstone,
  isBotMessage,
  isTwoPartyThread,
  othersSpokeBetween,
  storeMessage,
  upsertThread,
  type SlackMessage,
  type ThreadRow,
} from './store.js';

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
  // HuddleFM's replies and events in the bot's DM with it (DJ mode): protocol traffic, never a conversation.
  if (isFromHuddleFm(ev)) return handleHuddleFmMessage(ev);
  // Slackbot's system messages ("you were added to a user group…", often in a read-only DM): ignored entirely.
  if (isSlackbotUser(ev.user) || isSlackbotUser(ev.message?.user)) return;
  if (ev.subtype === 'message_changed') return handleEdit(ev);
  if (ev.subtype === 'message_deleted') return handleDelete(ev.channel, ev.deleted_ts, ev.previous_message);
  if (ev.hidden || !NEW_MESSAGE_SUBTYPES.has(ev.subtype)) return;
  if (isHiddenMessage(ev.text)) return; // `##` (guidelines): not stored, no events, never triggers anything
  return handleNewMessage(ev);
}

/** Mark the bot as addressed in a thread: engaged, counters reset. */
async function markAddressed(threadId: string, engaged: boolean) {
  await sql`update threads set engaged = ${engaged}, last_addressed_at = now(), messages_since_addressed = 0, last_activity_at = now()
            where id = ${threadId}`;
}

export async function disengage(threadId: string, reason: string, actor: string | null) {
  await sql`update threads set engaged = false, awaits_reply_from = null where id = ${threadId} and engaged`;
  await appendEvent(threadId, 'disengaged', actor, { reason });
}

async function handleNewMessage(ev: MessageEvent) {
  markMessage(ev.channel, ev.ts, { i_enter: Date.now() });
  const bot = await getBotIdentity();
  const channelId = ev.channel;
  const isDm = ev.channel_type === 'im';
  const isBot = isBotMessage(ev) || ev.user === bot.userId;
  const threadId = threadIdOf(channelId, threadRootTs(ev));
  const text = ev.text ?? '';
  // A DM with another bot or app (its user posting as a user): never a conversation. Cached per DM channel.
  if (isDm && !isBot && ev.user && (await isBotPeerDm(channelId, ev.user).catch(() => false))) return;
  const { mentionsBot, mentionsOthers } = isBot ? { mentionsBot: false, mentionsOthers: false } : mentionFacts(text, bot.userId);
  if (!isBot && ev.user && shouldRedirectGroupPing({ isDm, threadTs: ev.thread_ts, ts: ev.ts, mentionsBot, text }) && !isBangStop(text, bot.userId)) {
    await redirectGroupPing({ ...ev, user: ev.user }, bot);
    return;
  }

  let thread = await getThread(threadId);
  if (!thread && !isBot && (isDm || mentionsBot)) {
    thread = await upsertThread({ id: threadId, channelId, threadTs: threadRootTs(ev), isDm });
  }
  // Threads the bot was never part of: not stored (the context module backfills what it needs).
  if (!thread) return;
  markMessage(channelId, ev.ts, { i_thread: Date.now() });

  const { deleted } = await storeMessage(channelId, threadId, ev);
  if (deleted) return; // deleted before we got to process it
  await appendEvent(threadId, 'message', ev.user ?? (ev.bot_id ? `bot:${ev.bot_id}` : null), {
    ts: ev.ts,
    ...(ev.subtype ? { subtype: ev.subtype } : {}),
    ...(ev.files?.length ? { files: ev.files.length } : {}),
    ...(isBot ? { bot: true } : {}),
  });
  if (isBot || !ev.user) return; // bots never start a turn
  markMessage(channelId, ev.ts, { i_stored: Date.now() });

  const authorId = ev.user;
  if (isBangStop(text, bot.userId, { isDm })) return handleBangStop(channelId, threadRootTs(ev), authorId, ev.ts);
  let disengageDue = false;
  if (isDm || mentionsBot) {
    await markAddressed(threadId, true);
  } else if (thread.engaged) {
    disengageDue = await countUnaddressed(thread);
  }
  const quietPrefix = hasQuietPrefix(text);
  const followUp = !isDm && !mentionsBot && !mentionsOthers && !quietPrefix;
  // The bot's latest message asked this author something (or offered): their next message needs no gate, whatever
  // the idle time or engagement (taken atomically, so only the first message after the question counts).
  const awaitedReply = followUp && thread.awaitsReplyFrom === authorId ? await consumeAwaitedReply(threadId, authorId) : false;
  const twoParty = followUp && thread.engaged && !awaitedReply ? await isTwoPartyThread(thread, authorId) : false;
  // The bot's latest reply was for this author and nobody else has written since: still their conversation.
  const partner =
    followUp && thread.engaged && !awaitedReply && !twoParty && thread.lastBotPartner === authorId && thread.lastBotReplyTs
      ? !(await othersSpokeBetween(threadId, authorId, thread.lastBotReplyTs, ev.ts))
      : false;
  // The bot's latest reply asked someone else (or offered) and this is the first human message since: probably
  // answering the bot too, but less certain, so it goes through the gate at the partner threshold.
  const answersOther =
    followUp && thread.engaged && !awaitedReply && !twoParty && !partner && thread.lastBotReplyTs
      ? answersOtherOffer({
          awaitsReplyFrom: thread.awaitsReplyFrom,
          authorId,
          humansSinceReply: thread.awaitsReplyFrom && thread.awaitsReplyFrom !== authorId ? await othersSpokeBetween(threadId, null, thread.lastBotReplyTs, ev.ts) : true,
        })
      : false;

  const decision = decide({ isBot, isDm, mentionsBot, mentionsOthers, engaged: isDm || thread.engaged, disengageDue, twoParty, partner, awaitedReply, answersOther, quietPrefix });
  log.debug({ threadId, ts: ev.ts, decision }, 'message decision');
  if (decision.action === 'ignore') {
    if (decision.reason === 'disengaged') await disengage(threadId, 'idle', null);
    return;
  }
  if (decision.reason === 'direct') await markAddressed(threadId, true);

  markMessage(channelId, ev.ts, { i_decided: Date.now() });
  // Posting here failed with restricted_action_read_only_channel recently (core/slack.ts): no turns, no ephemerals.
  if (await isChannelReadOnly(channelId)) {
    log.debug({ threadId, ts: ev.ts }, 'read-only channel: no turn');
    return;
  }
  const entry = await guardEntry(authorId, channelId);
  markMessage(channelId, ev.ts, { i_guarded: Date.now() });
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

/** Count an unaddressed human message; returns true when the thread should disengage (25 messages / 7 days idle). */
async function countUnaddressed(thread: ThreadRow): Promise<boolean> {
  const [row] = await sql<{ messagesSinceAddressed: number; lastAddressedAt: Date | null; lastBotReplyAt: Date | null }[]>`
    update threads set messages_since_addressed = messages_since_addressed + 1, last_activity_at = now()
    where id = ${thread.id} returning messages_since_addressed, last_addressed_at, last_bot_reply_at`;
  if (!row) return false;
  return shouldDisengage(row, new Date(), { afterMessages: limits.disengageAfterMessages, afterMs: limits.disengageAfterMs });
}

async function handleEdit(ev: MessageEvent) {
  const msg = ev.message;
  if (!msg?.ts) return;
  // Deleting a thread parent that has replies turns it into a tombstone.
  if (msg.subtype === 'tombstone') return handleDelete(ev.channel, msg.ts, ev.previous_message ?? msg);
  if (isHiddenMessage(msg.text)) {
    // Edited to start with `##` (guidelines): treat like a deletion. Never visible before → just make sure nothing is stored.
    const wasVisible = ev.previous_message ? !isHiddenMessage(ev.previous_message.text) : true;
    if (wasVisible && msg.edited) return handleDelete(ev.channel, msg.ts, ev.previous_message ?? msg);
    await applyDelete(ev.channel, msg.ts);
    return;
  }
  const applied = await applyEdit(ev.channel, msg);
  let threadId = applied?.threadId ?? null;
  // Only a real change (text or files) is an edit: Slack re-sends a thread root unchanged whenever replies are added.
  let changed = Boolean(applied?.changed);
  if (!threadId && msg.edited) {
    // Edit processed before the original message (parallel workers): store the edited version for threads the
    // original will engage or already has. The original's own event still triggers the turn (and keeps this text).
    const candidate = threadIdOf(ev.channel, threadRootTs(msg));
    let known = Boolean(await getThread(candidate));
    if (!known && !isBotMessage(msg) && msg.user) {
      const bot = await getBotIdentity();
      const isDm = ev.channel_type === 'im';
      const mentionsBot = mentionFacts(msg.text ?? '', bot.userId).mentionsBot;
      // A group-ping trigger is answered in a new thread (guidelines), never under the original message.
      if ((isDm || mentionsBot) && !shouldRedirectGroupPing({ isDm, threadTs: msg.thread_ts, ts: msg.ts, mentionsBot, text: msg.text })) {
        await upsertThread({ id: candidate, channelId: ev.channel, threadTs: threadRootTs(msg), isDm });
        known = true;
      }
    }
    if (known) {
      await storeMessage(ev.channel, candidate, msg);
      threadId = candidate;
      changed = true;
    }
  }
  if (threadId && msg.edited && changed) await appendEvent(threadId, 'message_edited', msg.user ?? null, { ts: msg.ts });
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
  if (ts === parseThreadId(threadId).threadTs) await handleRootDeleted(threadId);
}

/**
 * The thread's root message is gone: Slack would turn any reply into a top-level channel message. Block posting
 * into it, stop the running turn at its next step, drop pending turns and cancel the thread's subagents (running
 * coding agents move to a DM with the admin instead).
 */
async function handleRootDeleted(threadId: string): Promise<void> {
  const { channelId, threadTs } = parseThreadId(threadId);
  await markThreadGone(channelId, threadTs);
  await requestThreadStop(threadId);
  await sql`update threads set root_deleted_at = now(), engaged = false where id = ${threadId}`;
  await sql`update turns set status = 'cancelled', finished_at = now() where thread_id = ${threadId} and status = 'pending'`;
  const cards = await cancelThreadRuns(threadId, 'system').catch((err) => (log.error({ err, threadId }, 'cancelThreadRuns failed'), []));
  // Coding agents aren't cancelled (that's the admin's call): they move to a DM thread with the admin.
  const rehomed = await rehomeCodingAgents(threadId).catch((err) => (log.error({ err, threadId }, 'rehomeCodingAgents failed'), []));
  await appendEvent(threadId, 'root_deleted', 'system', { cancelledCards: cards, rehomedCodingAgents: rehomed });
}
