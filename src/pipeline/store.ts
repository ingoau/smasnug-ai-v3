/** Stored copies of Slack messages and thread rows. */
import { sql, type Sql } from '../db/index.js';
import type { MessageAttachment, SlackFileRef, StoredMessage } from '../core/types.js';
import { attachmentsFromSlack, slackFileRefs } from '../context/normalize.js';
import { removeMessageFiles } from '../files/store.js';
import { log } from '../log.js';

export interface ThreadRow {
  id: string;
  channelId: string;
  threadTs: string;
  isDm: boolean;
  engaged: boolean;
  lastAddressedAt: Date | null;
  messagesSinceAddressed: number;
  backfilled: boolean;
  /** The bot's latest reply (any turn kind): idle clock, conversation partner, awaited answer (migration 220). */
  lastBotReplyAt?: Date | null;
  lastBotReplyTs?: string | null;
  lastBotPartner?: string | null;
  awaitsReplyFrom?: string | null;
}

/** Raw Slack message (the event, or `event.message` for message_changed). */
export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  text?: string;
  files?: { id: string; name?: string; mimetype?: string; url_private?: string; size?: number; mode?: string }[];
  edited?: { ts: string; user?: string };
  /** Forwarded messages and link unfurls (normalised and stored, attachmentsFromSlack). */
  attachments?: unknown[];
  /** Block Kit layout (rich_text body, context footers…); mention routing reads it (rules.ts mentionText). */
  blocks?: unknown[];
}

export function isBotMessage(m: SlackMessage): boolean {
  return Boolean(m.bot_id) || m.subtype === 'bot_message';
}

export function fileRefs(m: SlackMessage): SlackFileRef[] {
  // Its own files and forwarded messages' files; tombstones (a file deleted from the message) dropped.
  return slackFileRefs(m);
}

const slackTsDate = (ts: string) => new Date(Math.round(Number(ts) * 1000));

export async function getThread(threadId: string, tx: Sql = sql): Promise<ThreadRow | undefined> {
  const [row] = await tx<ThreadRow[]>`select * from threads where id = ${threadId}`;
  return row;
}

export async function upsertThread(t: { id: string; channelId: string; threadTs: string; isDm: boolean }): Promise<ThreadRow> {
  const [row] = await sql<ThreadRow[]>`
    insert into threads (id, channel_id, thread_ts, is_dm, engaged)
    values (${t.id}, ${t.channelId}, ${t.threadTs}, ${t.isDm}, ${t.isDm})
    on conflict (id) do update set last_activity_at = now()
    returning *`;
  return row!;
}

/**
 * Insert or refresh a stored message. Slack events can be processed out of order (parallel workers), so a newer
 * edit already stored is kept, and a row already marked deleted stays deleted (retention). Returns `deleted`.
 */
export async function storeMessage(channelId: string, threadId: string | null, m: SlackMessage): Promise<{ deleted: boolean }> {
  const files = fileRefs(m);
  const attachments: MessageAttachment[] = attachmentsFromSlack(m.attachments);
  const [row] = await sql<{ deleted: boolean }[]>`
    insert into messages (channel_id, ts, thread_id, user_id, bot_id, username, text, files, edited_at, attachments)
    values (${channelId}, ${m.ts}, ${threadId}, ${m.user ?? null}, ${m.bot_id ?? null},
            ${m.username ?? m.bot_profile?.name ?? null}, ${m.text ?? ''}, ${sql.json(files as any)},
            ${m.edited ? slackTsDate(m.edited.ts) : null}, ${sql.json(attachments as any)})
    on conflict (channel_id, ts) do update set
      thread_id = coalesce(messages.thread_id, excluded.thread_id),
      user_id = coalesce(messages.user_id, excluded.user_id),
      bot_id = coalesce(messages.bot_id, excluded.bot_id),
      username = coalesce(messages.username, excluded.username),
      text = case when messages.deleted then ''
                  when messages.edited_at is not null and (excluded.edited_at is null or excluded.edited_at < messages.edited_at) then messages.text
                  else excluded.text end,
      files = case when messages.deleted then '[]'::jsonb
                   when messages.edited_at is not null and (excluded.edited_at is null or excluded.edited_at < messages.edited_at) then messages.files
                   else excluded.files end,
      edited_at = greatest(messages.edited_at, excluded.edited_at),
      attachments = case when messages.deleted then '[]'::jsonb
                         when excluded.attachments = '[]'::jsonb then messages.attachments
                         else excluded.attachments end
    returning deleted`;
  return { deleted: Boolean(row?.deleted) };
}

/** Deletion seen before the message itself (out-of-order processing): remember it so the late insert stays empty. */
export async function insertTombstone(channelId: string, ts: string, threadId: string, userId: string | null) {
  await sql`
    insert into messages (channel_id, ts, thread_id, user_id, deleted) values (${channelId}, ${ts}, ${threadId}, ${userId}, true)
    on conflict (channel_id, ts) do update set text = '', files = '[]'::jsonb, attachments = '[]'::jsonb, deleted = true`;
}

/**
 * Apply an edit to a stored copy, only when the text or files actually differ: Slack sends `message_changed` for a
 * thread root whenever replies are added (reply count, latest reply), with the same text. Returns the stored row (if
 * we had one) and whether it changed. Previous texts are not kept.
 */
export async function applyEdit(channelId: string, m: SlackMessage): Promise<{ threadId: string | null; userId: string | null; changed: boolean } | undefined> {
  const files = fileRefs(m);
  const text = m.text ?? '';
  // The files it had: uploads removed from the message leave the file store too.
  const [before] = await sql<{ files: SlackFileRef[] }[]>`select files from messages where channel_id = ${channelId} and ts = ${m.ts} and not deleted`;
  // Link unfurls arrive (and removed previews leave) as a message_changed with the same text: the full message's
  // attachments are stored, but that alone is not an edit.
  const attachments = attachmentsFromSlack(m.attachments);
  await sql`update messages set attachments = ${sql.json(attachments as any)}
    where channel_id = ${channelId} and ts = ${m.ts} and not deleted and attachments is distinct from ${sql.json(attachments as any)}::jsonb`;
  const [row] = await sql<{ threadId: string | null; userId: string | null }[]>`
    update messages set text = ${text}, files = ${sql.json(files as any)},
      edited_at = ${m.edited ? slackTsDate(m.edited.ts) : sql`edited_at`}
    where channel_id = ${channelId} and ts = ${m.ts} and not deleted
      and (text is distinct from ${text} or files is distinct from ${sql.json(files as any)}::jsonb)
    returning thread_id, user_id`;
  if (row) {
    const kept = new Set(files.map((f) => f.id));
    const removed = (Array.isArray(before?.files) ? before.files : []).map((f) => f?.id).filter((id): id is string => !!id && !kept.has(id));
    if (removed.length) await removeMessageFiles(channelId, m.ts, removed).catch((err) => log.warn({ err }, 'removing edited-out files failed'));
    return { ...row, changed: true };
  }
  const [same] = await sql<{ threadId: string | null; userId: string | null }[]>`
    select thread_id, user_id from messages where channel_id = ${channelId} and ts = ${m.ts} and not deleted`;
  return same ? { ...same, changed: false } : undefined;
}

/** Retention: a deleted Slack message clears our stored copy (and traces that may hold one), and its uploads leave the file store. */
export async function applyDelete(channelId: string, ts: string): Promise<{ threadId: string | null; userId: string | null } | undefined> {
  const [before] = await sql<{ files: SlackFileRef[] }[]>`select files from messages where channel_id = ${channelId} and ts = ${ts}`;
  const [row] = await sql<{ threadId: string | null; userId: string | null }[]>`
    update messages set text = '', files = '[]'::jsonb, attachments = '[]'::jsonb, deleted = true, deleted_at = coalesce(deleted_at, now())
    where channel_id = ${channelId} and ts = ${ts}
    returning thread_id, user_id`;
  // Model traces in this channel that ran after the message was posted may hold a copy (thread or channel context;
  // src/agent/trace.ts). Ones still in flight are dropped when saved (saveTrace checks deleted_at).
  await sql`delete from traces where channel_id = ${channelId} and coalesce(finished_at, now()) >= to_timestamp(${ts}::numeric)`.catch((err) =>
    log.warn({ err }, 'dropping traces of a deleted message failed'),
  );
  const slackIds = (Array.isArray(before?.files) ? before.files : []).map((f) => f?.id).filter((id): id is string => !!id);
  await removeMessageFiles(channelId, ts).catch((err) => log.warn({ err }, 'removing deleted message files failed'));
  if (slackIds.length) await removeMessageFiles(channelId, ts, slackIds).catch((err) => log.warn({ err }, 'removing deleted message posts failed'));
  return row;
}

/** The bot's own Slack identity (core/slack.ts getBotIdentity): its stored messages carry either id. */
export interface BotIds {
  userId: string;
  botId: string;
}

/**
 * True when only the thread's original poster (= authorId) and this bot have spoken, as far as we have stored. A
 * reply from another bot (an integration, another AI bot) counts as someone else; a bot's root post doesn't.
 */
export async function isTwoPartyThread(thread: ThreadRow, authorId: string, bot: BotIds): Promise<boolean> {
  const all = await sql<{ userId: string | null; ts: string; botId: string | null }[]>`
    select user_id, ts, bot_id from messages
    where (thread_id = ${thread.id} or (channel_id = ${thread.channelId} and ts = ${thread.threadTs})) and (user_id is not null or bot_id is not null)
    order by ts::numeric`;
  const root = all.find((r) => r.ts === thread.threadTs);
  const own = (r: { userId: string | null; botId: string | null }) => r.userId === bot.userId || r.botId === bot.botId;
  // Without the root we don't know who started the thread (mid-thread mention, not backfilled yet). A bot-rooted
  // thread (e.g. the bot's own message after a group-ping redirect, or an integration's alert) was started by its
  // first human message.
  const opener = root?.botId ? all.find((r) => !r.botId && !own(r)) : root;
  if (!opener || opener.userId !== authorId) return false;
  return all.every((r) => own(r) || (r === root && r.botId) || (!r.botId && r.userId === authorId));
}

export async function loadMessages(channelId: string, ts: string[], tx: Sql = sql): Promise<StoredMessage[]> {
  if (ts.length === 0) return [];
  return tx<StoredMessage[]>`
    select channel_id, ts, thread_id, user_id, bot_id, username, text, files, edited_at, deleted, attachments
    from messages where channel_id = ${channelId} and ts = any(${ts}::text[]) and not deleted
    order by ts::numeric`;
}

/** The last `n` stored messages of a thread strictly before `beforeTs`. */
export async function recentMessages(threadId: string, beforeTs: string, n: number): Promise<StoredMessage[]> {
  const rows = await sql<StoredMessage[]>`
    select channel_id, ts, thread_id, user_id, bot_id, username, text, files, edited_at, deleted, attachments
    from messages where thread_id = ${threadId} and not deleted and ts::numeric < ${beforeTs}::numeric
    order by ts::numeric desc limit ${n}`;
  return rows.reverse();
}

/**
 * The bot replied in a thread (any turn kind): the idle clock restarts, `partnerId` (the turn's speaker) is who it
 * was talking with, and `awaitsReply` (rules.ts awaitsReply: a question, an offer or buttons) lets that person's next
 * message skip the gate. Called by the front agent after each delivered reply.
 */
export async function noteBotReply(threadId: string, o: { ts: string | null; partnerId: string; awaitsReply: boolean }): Promise<void> {
  await sql`
    update threads set last_bot_reply_at = now(), last_bot_reply_ts = coalesce(${o.ts}, last_bot_reply_ts),
      last_bot_partner = ${o.partnerId}, awaits_reply_from = ${o.awaitsReply ? o.partnerId : null}, last_activity_at = now()
    where id = ${threadId}`;
}

/**
 * Atomically take the "bot awaits your answer" flag for this author. True for the first message that takes it, while
 * the bot's reply is at most `maxAgeMs` old (a stale flag is cleared, not taken: hours later it's no answer).
 */
export async function consumeAwaitedReply(threadId: string, authorId: string, maxAgeMs: number): Promise<boolean> {
  const [row] = await sql<{ fresh: boolean }[]>`
    update threads set awaits_reply_from = null where id = ${threadId} and awaits_reply_from = ${authorId}
    returning coalesce(last_bot_reply_at > now() - ${maxAgeMs} * interval '1 millisecond', false) as fresh`;
  return Boolean(row?.fresh);
}

/**
 * True if someone other than `authorId` (anyone when null) and this bot wrote in the thread after `afterTs` and
 * before `beforeTs` (stored copies): another person, or another bot.
 */
export async function othersSpokeBetween(threadId: string, authorId: string | null, afterTs: string, beforeTs: string, bot: BotIds): Promise<boolean> {
  const [row] = await sql<{ spoke: boolean }[]>`
    select exists (
      select 1 from messages where thread_id = ${threadId} and not deleted and (user_id is not null or bot_id is not null)
        and user_id is distinct from ${bot.userId} and bot_id is distinct from ${bot.botId}
        and (${authorId}::text is null or user_id is distinct from ${authorId}) and ts::numeric > ${afterTs}::numeric and ts::numeric < ${beforeTs}::numeric
    ) as spoke`;
  return Boolean(row?.spoke);
}

/**
 * True if `authorId` asked for background work in this thread that is still going or just came back: a subagent run
 * started by them (its turn's author, else the subagent's owner) that is queued / running, or finished at most
 * `withinMs` ago. Their follow-ups ("how's it going?", "is this good?") are most likely for the bot.
 */
export async function isRunRequester(threadId: string, authorId: string, withinMs: number): Promise<boolean> {
  const [row] = await sql<{ yes: boolean }[]>`
    select exists (
      select 1 from runs r join subagents s on s.id = r.subagent_id
      left join turns t on t.id = r.turn_id and t.kind = 'user'
      where r.thread_id = ${threadId} and coalesce(t.author_id, s.owner_id) = ${authorId}
        and (r.status in ('queued', 'running') or (r.status = 'complete' and r.finished_at > now() - ${withinMs} * interval '1 millisecond'))
    ) as yes`;
  return Boolean(row?.yes);
}
