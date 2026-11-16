/**
 * Message intake: storage, engagement bookkeeping, deterministic rules, entry guard, then into the debounce batch.
 * The relevance gate runs later, once per debounced batch (see fire.ts).
 */
import { appendEvent, isCodeChannelRoot, parseThreadId, threadIdOf } from '../core/events.js';
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
import { dropHeldMessage, holdForConsent, noticePolicyUpdate, updateHeldMessage } from './consent.js';
import { hasAgreed } from '../features/privacy.js';
import { handleBangStop, redirectGroupPing } from './guideline-actions.js';
import { hasQuietPrefix, isBangStop, isHiddenMessage, shouldRedirectGroupPing } from './guidelines.js';
import { answersOtherOffer, awaitedReplyFresh, decide, isRecentPartner, isSlackbotUser, mentionFacts, mentionText, NEW_MESSAGE_SUBTYPES, shouldDisengage, threadRootTs, conversationRootTs, isTopLevel } from './rules.js';
import { noteCodeChannelActivity, routeCodeChannel } from './code-channel-intake.js';
import { codeChannelsEnabled } from '../features/code-channels/settings.js';
import { isCodeChannel } from '../features/code-channels/store.js';
import { isBotPeerDm } from './dm-peer.js';
import { removeMessageFromTurns } from './scheduler.js';
import { handleHuddleFmMessage, isFromHuddleFm } from '../features/huddlefm/inbound.js';
import { showIntakeStatus } from './session-status.js';
import { fetchHistoryBefore, fetchReplies } from '../context/slack-messages.js';
import { compareTs } from '../context/format.js';
import {
  applyDelete,
  applyEdit,
  consumeAwaitedReply,
  getThread,
  insertTombstone,
  isBotMessage,
  isRunRequester,
  isTwoPartyThread,
  othersSpokeBetween,
  storeMessage,
  upsertThread,
  type SlackMessage,
  type ThreadRow,
} from './store.js';

/** How far back a join looks for the mention that prompted the invite. */
const JOIN_REPLAY_WINDOW_S = 10 * 60;
/** The bot's question / offer (threads.awaits_reply_from) counts as awaiting an answer for this long after its reply. */
export const AWAITED_REPLY_MAX_AGE_MS = 20 * 60 * 1000;
/** A subagent run's requester stays a partner-level author for this long after the run finished (isRunRequester). */
export const RUN_REQUESTER_WINDOW_MS = 15 * 60 * 1000;

export const RATE_LIMITED_TEXT = "You're sending me a lot of messages — give me a bit and try again.";

interface MessageEvent extends SlackMessage {
  type: 'message';
  channel: string;
  channel_type?: 'im' | 'mpim' | 'channel' | 'group';
  hidden?: boolean;
  message?: SlackMessage;
  previous_message?: SlackMessage;
  deleted_ts?: string;
  /** Message metadata (a parent-agent post in a code channel carries a marker, features/code-channels/parent-message.ts). */
  metadata?: unknown;
}

/** Is the channel a code channel (feature on, recorded)? For edits / deletes, which never adopt. */
async function inCodeChannel(channelId: string, isDm: boolean): Promise<boolean> {
  if (isDm || channelId.startsWith('D')) return false;
  if (!(await codeChannelsEnabled())) return false;
  return isCodeChannel(channelId).catch(() => false);
}

export async function handleMessageEvent(ev: MessageEvent) {
  if (!ev.channel) return;
  // HuddleFM's replies and events in the bot's DM with it (DJ mode): protocol traffic, never a conversation.
  if (isFromHuddleFm(ev)) return handleHuddleFmMessage(ev);
  // Slackbot's system messages ("you were added to a user group…", often in a read-only DM): ignored entirely.
  if (isSlackbotUser(ev.user) || isSlackbotUser(ev.message?.user)) return;
  if (ev.subtype === 'message_changed') return handleEdit(ev);
  if (ev.subtype === 'message_deleted') return handleDelete(ev.channel, ev.deleted_ts, ev.previous_message);
  if (ev.subtype === 'channel_join' || ev.subtype === 'group_join') return handleJoin(ev);
  if (ev.hidden || !NEW_MESSAGE_SUBTYPES.has(ev.subtype)) return;
  if (isHiddenMessage(ev.text)) return; // `##` (guidelines): not stored, no events, never triggers anything
  return handleNewMessage(ev);
}

/**
 * The bot was just added to a channel, usually from Slack's "invite them?" prompt after someone mentioned it there:
 * that mention was never delivered (the bot wasn't a member), so replay the recent ones now.
 */
async function handleJoin(ev: MessageEvent & { inviter?: string }) {
  const bot = await getBotIdentity();
  // No inviter: the bot joined by itself (send_message's conversations.join) or an admin added it; nothing to answer.
  if (ev.user !== bot.userId || !ev.inviter) return;
  const oldest = (Number(ev.ts) - JOIN_REPLAY_WINDOW_S).toFixed(6);
  const top = await fetchHistoryBefore(ev.channel, { latest: ev.ts, limit: 20 });
  const recent = top.filter((m) => compareTs(m.ts, oldest) > 0);
  // Mentions in a thread: the parent's latest_reply moved within the window.
  for (const parent of top.filter((m) => m.latest_reply && compareTs(m.latest_reply, oldest) > 0)) {
    const replies = await fetchReplies(ev.channel, parent.ts, { latest: ev.ts }).catch((err) => {
      log.warn({ err, channel: ev.channel, ts: parent.ts }, 'join replay: replies fetch failed');
      return [];
    });
    recent.push(...replies.filter((m) => m.ts !== parent.ts && compareTs(m.ts, oldest) > 0));
  }
  const mentions = recent.filter(
    (m) => NEW_MESSAGE_SUBTYPES.has(m.subtype) && m.subtype !== 'bot_message' && !m.bot_id && m.user === ev.inviter && mentionFacts(mentionText(m), bot.userId).mentionsBot,
  );
  if (!mentions.length) return;
  // Already stored: seen before (the bot was removed and re-invited), so not answered again.
  const seen = new Set((await sql<{ ts: string }[]>`select ts from messages where channel_id = ${ev.channel} and ts in ${sql(mentions.map((m) => m.ts))}`).map((r) => r.ts));
  for (const m of mentions.filter((m) => !seen.has(m.ts)).sort((a, b) => compareTs(a.ts, b.ts))) {
    await handleMessageEvent({ ...m, type: 'message', channel: ev.channel, ...(ev.channel_type ? { channel_type: ev.channel_type } : {}) });
  }
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
  const text = ev.text ?? '';
  // A DM with another bot or app (its user posting as a user): never a conversation. Cached per DM channel.
  if (isDm && !isBot && ev.user && (await isBotPeerDm(channelId, ev.user).catch(() => false))) return;
  const { mentionsBot, mentionsOthers } = isBot ? { mentionsBot: false, mentionsOthers: false } : mentionFacts(mentionText(ev), bot.userId);
  // Code channels (docs/code-channels.md): top-level messages are one conversation, `${channel}:0`. Null elsewhere.
  const cc = await routeCodeChannel(ev, { isDm, isBot, mentionsBot, botId: bot.botId });
  const ccConversation = Boolean(cc?.topLevel);
  const parentPost = cc?.parent ?? null;
  const rootTs = conversationRootTs(ev, ccConversation);
  const threadId = threadIdOf(channelId, rootTs);
  if (cc && ((!isBot && ev.user) || parentPost)) await noteCodeChannelActivity(channelId, parentPost?.requesterId ?? ev.user ?? null);
  // In a code channel's conversation replies are top level anyway: no group-ping redirect.
  if (!ccConversation && !isBot && ev.user && shouldRedirectGroupPing({ isDm, threadTs: ev.thread_ts, ts: ev.ts, mentionsBot, text }) && !isBangStop(text, bot.userId)) {
    await redirectGroupPing({ ...ev, user: ev.user }, bot);
    return;
  }

  let thread = await getThread(threadId);
  if (!thread && ((!isBot && (isDm || mentionsBot || ccConversation)) || parentPost)) {
    thread = await upsertThread({ id: threadId, channelId, threadTs: rootTs, isDm });
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
  // A parent-agent post: an instruction from the requester (the turn is theirs, parent-message.ts).
  if (parentPost) await appendEvent(threadId, 'parent_message', parentPost.requesterId, { ts: ev.ts, parentThreadId: parentPost.parentThreadId });
  // Bots never start a turn (a parent-agent post in a code channel is the one exception).
  if (!parentPost && (isBot || !ev.user)) return;
  markMessage(channelId, ev.ts, { i_stored: Date.now() });

  const authorId = parentPost ? parentPost.requesterId : ev.user!;
  if (!parentPost && isBangStop(text, bot.userId, { isDm })) return handleBangStop(channelId, rootTs, authorId, ev.ts);
  let disengageDue = false;
  // A code channel's conversation is always engaged and never disengages (like a DM).
  if (isDm || mentionsBot || ccConversation) {
    await markAddressed(threadId, true);
  } else if (thread.engaged) {
    disengageDue = await countUnaddressed(thread);
  }
  const quietPrefix = hasQuietPrefix(text);
  const followUp = !isDm && !mentionsBot && !mentionsOthers && !quietPrefix;
  // The bot's latest message asked this author something (or offered) at most AWAITED_REPLY_MAX_AGE_MS ago: their
  // next message needs no gate, even in a disengaged thread (taken atomically, so only the first message after the
  // question counts; a stale flag is cleared instead).
  const now = new Date();
  const awaitsReplyFrom = awaitedReplyFresh(thread.lastBotReplyAt, now, AWAITED_REPLY_MAX_AGE_MS) ? thread.awaitsReplyFrom : null;
  const awaitedReply = followUp && thread.awaitsReplyFrom === authorId ? await consumeAwaitedReply(threadId, authorId, AWAITED_REPLY_MAX_AGE_MS) : false;
  const twoParty = followUp && thread.engaged && !awaitedReply ? await isTwoPartyThread(thread, authorId, bot) : false;
  // The bot's latest reply was for this author and nobody else (person or other bot) has written since: still their
  // conversation.
  const lastReplyTs = followUp && thread.engaged && !awaitedReply && !twoParty && thread.lastBotPartner === authorId ? thread.lastBotReplyTs : null;
  const othersSinceReply = lastReplyTs ? await othersSpokeBetween(threadId, authorId, lastReplyTs, ev.ts, bot) : false;
  const partner = Boolean(lastReplyTs) && !othersSinceReply;
  // The bot's latest reply asked someone else (or offered) and this is the first human message since: probably
  // answering the bot too, but less certain, so it goes through the gate at the partner threshold.
  const answersOther =
    followUp && thread.engaged && !awaitedReply && !twoParty && !partner && thread.lastBotReplyTs
      ? answersOtherOffer({
          awaitsReplyFrom,
          authorId,
          humansSinceReply: awaitsReplyFrom && awaitsReplyFrom !== authorId ? await othersSpokeBetween(threadId, null, thread.lastBotReplyTs, ev.ts, bot) : true,
        })
      : false;
  // They asked for a subagent run here that is still going or just reported back: probably following up on it.
  const runRequester =
    followUp && thread.engaged && !awaitedReply && !twoParty && !partner && !answersOther ? await isRunRequester(threadId, authorId, RUN_REQUESTER_WINDOW_MS) : false;
  // Their conversation a few minutes ago, but someone else wrote since: gated at the intermediate threshold.
  const recentPartner =
    lastReplyTs && !partner && !answersOther
      ? isRecentPartner({ authorId, lastBotPartner: thread.lastBotPartner, lastBotReplyAt: thread.lastBotReplyAt, othersSpoke: othersSinceReply }, now, limits.recentPartnerMs)
      : false;

  const decision = decide({
    isBot,
    isDm,
    mentionsBot,
    mentionsOthers,
    engaged: isDm || ccConversation || thread.engaged,
    disengageDue,
    twoParty,
    partner,
    awaitedReply,
    answersOther,
    runRequester,
    recentPartner,
    quietPrefix,
    codeChannel: ccConversation,
    parentPost: Boolean(parentPost),
  });
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
        { channel: channelId, user: authorId, text: RATE_LIMITED_TEXT, ...(ev.thread_ts && !ccConversation ? { thread_ts: ev.thread_ts } : {}) },
        { idempotencyKey: `rate-limited:${channelId}:${ev.ts}` },
      ).catch((err) => log.warn({ err }, 'rate-limit ephemeral failed'));
    }
    return;
  }

  // Privacy policy never agreed (consent.ts): a DM / mention is held behind the prompt, anything else dropped. The
  // message stays stored as context either way. Agreed to an earlier version: a one-off "updated" notice, then on.
  if (!(await hasAgreed(authorId))) {
    // A code channel's conversation is a session with the bot (like a DM): held too. A parent post's requester
    // agreed in the parent thread; if not (withdrawn since), it's dropped, never held.
    if (decision.reason === 'dm' || decision.reason === 'mention' || decision.reason === 'code_channel') {
      await holdForConsent({
        userId: authorId,
        channelId,
        conversation: isDm ? channelId : threadId,
        ...(ev.thread_ts && !ccConversation ? { promptThreadTs: ev.thread_ts } : {}),
        messageTs: ev.ts,
        item: { kind: 'batch', threadId, ts: ev.ts, reason: decision.reason },
      });
    }
    return;
  }
  if (!parentPost) await noticePolicyUpdate({ userId: authorId, channelId, ...(ev.thread_ts && !ccConversation ? { threadTs: ev.thread_ts } : {}), messageTs: ev.ts });

  // DMs and mentions (and parent posts) get the status indicator right away, before the debounce window (fire-and-forget).
  if (decision.reason === 'dm' || decision.reason === 'mention' || decision.reason === 'parent') showIntakeStatus(threadId, authorId, ev.ts);
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
    await dropHeldMessage(ev.channel, msg.ts);
    return;
  }
  if (msg.edited) await updateHeldMessage(ev.channel, msg);
  const applied = await applyEdit(ev.channel, msg);
  let threadId = applied?.threadId ?? null;
  // Only a real change (text or files) is an edit: Slack re-sends a thread root unchanged whenever replies are added.
  let changed = Boolean(applied?.changed);
  if (!threadId && msg.edited) {
    // Edit processed before the original message (parallel workers): store the edited version for threads the
    // original will engage or already has. The original's own event still triggers the turn (and keeps this text).
    const isDm = ev.channel_type === 'im';
    const cc = await inCodeChannel(ev.channel, isDm);
    const candidate = threadIdOf(ev.channel, conversationRootTs(msg, cc));
    let known = Boolean(await getThread(candidate));
    if (!known && !isBotMessage(msg) && msg.user) {
      const bot = await getBotIdentity();
      const mentionsBot = mentionFacts(mentionText(msg), bot.userId).mentionsBot;
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
  // Held behind the privacy prompt (consent.ts): a group ping held there has no stored row or thread to go by.
  await dropHeldMessage(channelId, ts);
  const row = await applyDelete(channelId, ts);
  let threadId = row?.threadId ?? null;
  if (!threadId && prev) {
    const cc = await inCodeChannel(channelId, false);
    const candidate = threadIdOf(channelId, conversationRootTs({ ts, ...(prev.thread_ts ? { thread_ts: prev.thread_ts } : {}) }, cc));
    if (await getThread(candidate)) threadId = candidate;
  }
  if (!threadId) return;
  if (!row) await insertTombstone(channelId, ts, threadId, prev?.user ?? null);
  await appendEvent(threadId, 'message_deleted', row?.userId ?? prev?.user ?? null, { ts });
  const authorId = row?.userId ?? prev?.user;
  if (authorId) await removeFromBatch(threadId, authorId, ts);
  // The deleted message was all the running turn was answering: stop it (the same flag `!stop` sets), silently.
  const orphaned = await removeMessageFromTurns(threadId, ts, () => requestThreadStop(threadId));
  if (orphaned != null) await appendEvent(threadId, 'turn_trigger_deleted', 'system', { turnId: orphaned, ts });
  if (ts === parseThreadId(threadId).threadTs) await handleRootDeleted(threadId);
  // A code channel's top-level message is stored in `${channel}:0`, but may root a Slack thread of its own.
  else if (isCodeChannelRoot(parseThreadId(threadId).threadTs) && isTopLevel({ ts, ...(prev?.thread_ts ? { thread_ts: prev.thread_ts } : {}) })) {
    const sub = threadIdOf(channelId, ts);
    if (await getThread(sub)) await handleRootDeleted(sub);
  }
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
