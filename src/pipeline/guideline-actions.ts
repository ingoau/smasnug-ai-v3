/**
 * Side effects for the workspace AI-bot guidelines (pure detection in guidelines.ts):
 * - `@bot !stop` runs the stop handler (stop.ts),
 * - a group ping on a top-level triggering message moves the conversation into a new top-level bot message.
 */
import { appendEvent, threadIdOf } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { addToBatch } from './debounce.js';
import { guardEntry } from './entry.js';
import { groupRedirectText } from './guidelines.js';
import { RATE_LIMITED_TEXT } from './intake.js';
import { handleAgentSessionStopped } from './stop.js';
import { storeMessage, upsertThread, type SlackMessage } from './store.js';

/** Rule 2: `@bot !stop` stops the current response in the message's thread (stop.ts). Anyone may. Never starts a turn. */
export async function handleBangStop(channelId: string, threadTs: string, userId: string, messageTs: string): Promise<void> {
  log.info({ channelId, threadTs, userId }, '!stop message');
  await handleAgentSessionStopped({ type: 'agent_session_stopped', channel: channelId, thread_ts: threadTs, user: userId, event_ts: messageTs });
}

/**
 * Rule 3: a top-level channel message that pings a group and triggers the bot. Instead of replying under it, post a
 * new top-level message (idempotent on the source ts), store the user's message as the first message of that new
 * thread (so the agent sees the question there; the group-ping thread is never engaged) and run the turn there.
 * Returns the new thread id, or null when nothing was started.
 */
export async function redirectGroupPing(ev: SlackMessage & { channel: string; user: string }, bot: { userId: string; botId: string }): Promise<string | null> {
  const channelId = ev.channel;
  const authorId = ev.user;
  const entry = await guardEntry(authorId, channelId);
  if (!entry.ok) {
    if (entry.reason === 'rate_limited') {
      await slackCall('chat.postEphemeral', { channel: channelId, user: authorId, text: RATE_LIMITED_TEXT }, { idempotencyKey: `rate-limited:${channelId}:${ev.ts}` }).catch((err) =>
        log.warn({ err }, 'rate-limit ephemeral failed'),
      );
    }
    return null;
  }

  const permalink = await slackCall<any>('chat.getPermalink', { channel: channelId, message_ts: ev.ts })
    .then((r) => (typeof r?.permalink === 'string' ? r.permalink : undefined))
    .catch((err) => {
      log.warn({ err }, 'getPermalink failed');
      return undefined;
    });
  const text = groupRedirectText(authorId, permalink);
  const res = await slackCall<any>('chat.postMessage', { channel: channelId, text, unfurl_links: false, unfurl_media: false }, { idempotencyKey: `group-redirect:${channelId}:${ev.ts}` });
  const rootTs: string | undefined = res?.ts;
  if (!rootTs) throw new Error('group redirect: chat.postMessage returned no ts');

  const threadId = threadIdOf(channelId, rootTs);
  await upsertThread({ id: threadId, channelId, threadTs: rootTs, isDm: false });
  // Our own root message (its message event may arrive before the thread row exists and would then be dropped).
  await storeMessage(channelId, threadId, { ts: rootTs, user: bot.userId, bot_id: bot.botId, text });
  // The context copy: the user's message is stored under the NEW thread (rows are keyed by channel + ts).
  const { deleted } = await storeMessage(channelId, threadId, ev);
  if (deleted) return null;
  await appendEvent(threadId, 'group_redirect', 'bot', { sourceThreadId: threadIdOf(channelId, ev.ts), sourceTs: ev.ts });
  await appendEvent(threadId, 'message', authorId, { ts: ev.ts, ...(ev.subtype ? { subtype: ev.subtype } : {}), redirected: true });
  await sql`update threads set engaged = true, last_addressed_at = now(), messages_since_addressed = 0, last_activity_at = now()
            where id = ${threadId}`;
  await addToBatch(threadId, authorId, ev.ts, 'mention');
  log.info({ threadId, sourceTs: ev.ts }, 'group ping: conversation moved to a new top-level message');
  return threadId;
}
