/** Stored copies of Slack messages and thread rows. */
import { sql, type Sql } from '../db/index.js';
import type { SlackFileRef, StoredMessage } from '../core/types.js';

export interface ThreadRow {
  id: string;
  channelId: string;
  threadTs: string;
  isDm: boolean;
  engaged: boolean;
  lastAddressedAt: Date | null;
  messagesSinceAddressed: number;
  backfilled: boolean;
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
  files?: { id: string; name?: string; mimetype?: string; url_private?: string }[];
  edited?: { ts: string; user?: string };
}

export function isBotMessage(m: SlackMessage): boolean {
  return Boolean(m.bot_id) || m.subtype === 'bot_message';
}

export function fileRefs(m: SlackMessage): SlackFileRef[] {
  return (m.files ?? [])
    .filter((f) => f && f.id)
    .map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, urlPrivate: f.url_private }));
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

/** Apply an edit to a stored copy. Returns the stored row (if we had one). */
export async function applyEdit(channelId: string, m: SlackMessage): Promise<{ threadId: string | null; userId: string | null } | undefined> {
  const files = fileRefs(m);
  const [row] = await sql<{ threadId: string | null; userId: string | null }[]>`
    update messages set text = ${m.text ?? ''}, files = ${sql.json(files as any)},
      edited_at = ${m.edited ? slackTsDate(m.edited.ts) : sql`edited_at`}
    where channel_id = ${channelId} and ts = ${m.ts} and not deleted
    returning thread_id, user_id`;
  return row;
}

/** Retention: a deleted Slack message clears our stored copy. */
export async function applyDelete(channelId: string, ts: string): Promise<{ threadId: string | null; userId: string | null } | undefined> {
  const [row] = await sql<{ threadId: string | null; userId: string | null }[]>`
    update messages set text = '', files = '[]'::jsonb, deleted = true
    where channel_id = ${channelId} and ts = ${ts}
    returning thread_id, user_id`;
  return row;
}

/** True when only the thread's original poster (= authorId) and bots have spoken, as far as we have stored. */
export async function isTwoPartyThread(thread: ThreadRow, authorId: string): Promise<boolean> {
  const rows = await sql<{ userId: string | null; ts: string }[]>`
    select user_id, ts from messages
    where thread_id = ${thread.id} and bot_id is null and user_id is not null`;
  const root = rows.find((r) => r.ts === thread.threadTs);
  // Without the root we don't know who started the thread (mid-thread mention, not backfilled yet).
  if (!root || root.userId !== authorId) return false;
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
