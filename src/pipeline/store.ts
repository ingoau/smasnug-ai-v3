/** Stored copies of Slack messages and thread rows. */
import { sql, type Sql } from '../db/index.js';
import type { SlackFileRef, StoredMessage } from '../core/types.js';
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
}

export function isBotMessage(m: SlackMessage): boolean {
  return Boolean(m.bot_id) || m.subtype === 'bot_message';
}

export function fileRefs(m: SlackMessage): SlackFileRef[] {
  // Tombstones: a file deleted from the message (Slack keeps a placeholder).
  return (m.files ?? [])
    .filter((f) => f && f.id && f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit')
    .map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, urlPrivate: f.url_private, ...(typeof f.size === 'number' ? { size: f.size } : {}) }));
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
  const [row] = await sql<{ deleted: boolean }[]>`
    insert into messages (channel_id, ts, thread_id, user_id, bot_id, username, text, files, edited_at)
    values (${channelId}, ${m.ts}, ${threadId}, ${m.user ?? null}, ${m.bot_id ?? null},
            ${m.username ?? m.bot_profile?.name ?? null}, ${m.text ?? ''}, ${sql.json(files as any)},
            ${m.edited ? slackTsDate(m.edited.ts) : null})
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
      edited_at = greatest(messages.edited_at, excluded.edited_at)
    returning deleted`;
  return { deleted: Boolean(row?.deleted) };
}

/** Deletion seen before the message itself (out-of-order processing): remember it so the late insert stays empty. */
export async function insertTombstone(channelId: string, ts: string, threadId: string, userId: string | null) {
  await sql`
    insert into messages (channel_id, ts, thread_id, user_id, deleted) values (${channelId}, ${ts}, ${threadId}, ${userId}, true)
    on conflict (channel_id, ts) do update set text = '', files = '[]'::jsonb, deleted = true`;
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

/** Retention: a deleted Slack message clears our stored copy, and its uploads leave the file store. */
export async function applyDelete(channelId: string, ts: string): Promise<{ threadId: string | null; userId: string | null } | undefined> {
  const [before] = await sql<{ files: SlackFileRef[] }[]>`select files from messages where channel_id = ${channelId} and ts = ${ts}`;
  const [row] = await sql<{ threadId: string | null; userId: string | null }[]>`
    update messages set text = '', files = '[]'::jsonb, deleted = true
    where channel_id = ${channelId} and ts = ${ts}
    returning thread_id, user_id`;
  const slackIds = (Array.isArray(before?.files) ? before.files : []).map((f) => f?.id).filter((id): id is string => !!id);
  await removeMessageFiles(channelId, ts).catch((err) => log.warn({ err }, 'removing deleted message files failed'));
  if (slackIds.length) await removeMessageFiles(channelId, ts, slackIds).catch((err) => log.warn({ err }, 'removing deleted message posts failed'));
  return row;
}

/** True when only the thread's original poster (= authorId) and bots have spoken, as far as we have stored. */
export async function isTwoPartyThread(thread: ThreadRow, authorId: string): Promise<boolean> {
  const all = await sql<{ userId: string | null; ts: string; botId: string | null }[]>`
    select user_id, ts, bot_id from messages
    where (thread_id = ${thread.id} or (channel_id = ${thread.channelId} and ts = ${thread.threadTs})) and user_id is not null
    order by ts::numeric`;
  const root = all.find((r) => r.ts === thread.threadTs);
  const rows = all.filter((r) => !r.botId);
  // Without the root we don't know who started the thread (mid-thread mention, not backfilled yet). A bot-rooted
  // thread (e.g. the bot's own message after a group-ping redirect) was started by its first human message.
  const opener = root?.botId ? rows[0] : root;
  if (!opener || opener.userId !== authorId) return false;
  return rows.every((r) => r.userId === authorId);
}

export async function loadMessages(channelId: string, ts: string[], tx: Sql = sql): Promise<StoredMessage[]> {
  if (ts.length === 0) return [];
  return tx<StoredMessage[]>`
    select channel_id, ts, thread_id, user_id, bot_id, username, text, files, edited_at, deleted
    from messages where channel_id = ${channelId} and ts = any(${ts}::text[]) and not deleted
    order by ts::numeric`;
}

/** The last `n` stored messages of a thread strictly before `beforeTs`. */
export async function recentMessages(threadId: string, beforeTs: string, n: number): Promise<StoredMessage[]> {
  const rows = await sql<StoredMessage[]>`
    select channel_id, ts, thread_id, user_id, bot_id, username, text, files, edited_at, deleted
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

/** Atomically take the "bot awaits your answer" flag for this author. True for the first message that takes it. */
export async function consumeAwaitedReply(threadId: string, authorId: string): Promise<boolean> {
  const rows = await sql`update threads set awaits_reply_from = null where id = ${threadId} and awaits_reply_from = ${authorId} returning id`;
  return rows.length > 0;
}

/**
 * True if a human other than `authorId` (any human when null) wrote in the thread after `afterTs` and before
 * `beforeTs` (stored copies).
 */
export async function othersSpokeBetween(threadId: string, authorId: string | null, afterTs: string, beforeTs: string): Promise<boolean> {
  const [row] = await sql<{ spoke: boolean }[]>`
    select exists (
      select 1 from messages where thread_id = ${threadId} and not deleted and bot_id is null and user_id is not null
        and (${authorId}::text is null or user_id <> ${authorId}) and ts::numeric > ${afterTs}::numeric and ts::numeric < ${beforeTs}::numeric
    ) as spoke`;
  return Boolean(row?.spoke);
}
