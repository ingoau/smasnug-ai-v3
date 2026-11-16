/**
 * The `code_channels` table (migration 347, docs/code-channels.md): which channels are code channels, their parent
 * thread, origin, seed and lifecycle. `isCodeChannel` is the cached check intake uses.
 *
 * Retention and withdrawal (spec, Lifecycle): the row belongs to the channel's conversation thread
 * (`${channel}:0`, FK on delete cascade), so it goes when retention deletes that thread. `retainCodeChannels` blanks
 * seed summaries and briefs after the retention window (they're copies of thread content, like messages) and
 * deletes archived rows idle past it; `forgetUserCodeChannelData` blanks them for a privacy withdrawal.
 */
import { limits } from '../../config.js';
import { codeChannelThreadId } from '../../core/events.js';
import { sql } from '../../db/index.js';

export type CodeChannelKind = 'fork' | 'task' | 'adopted';

export interface CodeChannel {
  channelId: string;
  threadId: string;
  sessionId: string;
  kind: CodeChannelKind;
  name: string;
  parentThreadId: string | null;
  originChannelId: string | null;
  originTs: string | null;
  seedTs: string | null;
  seedSummary: string | null;
  brief: string | null;
  createdBy: string | null;
  requesterId: string | null;
  isPrivate: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  warnedAt: Date | null;
  archivedAt: Date | null;
  /** The closing summary a failed close already wrote (reused by the next attempt; cleared by any message). */
  closingSummary: string | null;
  /** Failed sweep closes since the last message; the sweep stops at CLOSE_MAX_ATTEMPTS. */
  closeFailures: number;
  /** The sweep's next close attempt not before this. */
  closeRetryAt: Date | null;
}

/** The sweep gives up closing a channel after this many failed attempts. */
export const CLOSE_MAX_ATTEMPTS = 5;

export interface NewCodeChannel {
  channelId: string;
  sessionId: string;
  kind: CodeChannelKind;
  name: string;
  parentThreadId?: string | null;
  origin?: { channelId: string; ts: string } | null;
  seedSummary?: string | null;
  brief?: string | null;
  createdBy?: string | null;
  requesterId?: string | null;
  isPrivate?: boolean;
}

// ---- isCodeChannel cache ---------------------------------------------------------------------------------------

/** Negative answers expire sooner: a channel another worker just created must be recognised quickly. */
const NEGATIVE_TTL_MS = 5_000;
const CACHE_MAX = 5_000;
const cache = new Map<string, { at: number; value: boolean }>();

function remember(channelId: string, value: boolean) {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(channelId, { at: Date.now(), value });
}

/** Is this channel a code channel (archived ones included)? Cached in-process (limits.codeChannelCacheMs). */
export async function isCodeChannel(channelId: string): Promise<boolean> {
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < (hit.value ? limits.codeChannelCacheMs : NEGATIVE_TTL_MS)) return hit.value;
  const [row] = await sql<{ one: number }[]>`select 1 as one from code_channels where channel_id = ${channelId}`;
  remember(channelId, !!row);
  return !!row;
}

/** Drop cached answers (one channel, or all). */
export function invalidateCodeChannelCache(channelId?: string) {
  if (channelId) cache.delete(channelId);
  else cache.clear();
}

// ---- store -----------------------------------------------------------------------------------------------------

/**
 * Record a code channel (and its conversation thread `${channel}:0`). Idempotent: a channel or session id that's
 * already recorded returns the existing row unchanged (`created: false`).
 */
export async function createCodeChannelRow(c: NewCodeChannel): Promise<{ row: CodeChannel; created: boolean }> {
  const threadId = codeChannelThreadId(c.channelId);
  const row = await sql.begin(async (tx) => {
    await tx`insert into threads (id, channel_id, thread_ts, is_dm) values (${threadId}, ${c.channelId}, '0', false) on conflict (id) do nothing`;
    const [inserted] = await tx<CodeChannel[]>`
      insert into code_channels (channel_id, thread_id, session_id, kind, name, parent_thread_id, origin_channel_id, origin_ts,
                                 seed_summary, brief, created_by, requester_id, is_private)
      values (${c.channelId}, ${threadId}, ${c.sessionId}, ${c.kind}, ${c.name}, ${c.parentThreadId ?? null},
              ${c.origin?.channelId ?? null}, ${c.origin?.ts ?? null}, ${c.seedSummary ?? null}, ${c.brief ?? null},
              ${c.createdBy ?? null}, ${c.requesterId ?? null}, ${c.isPrivate ?? false})
      on conflict do nothing
      returning *`;
    return inserted;
  });
  remember(c.channelId, true);
  if (row) return { row, created: true };
  const [existing] = await sql<CodeChannel[]>`select * from code_channels where channel_id = ${c.channelId} or session_id = ${c.sessionId} limit 1`;
  if (!existing) throw new Error(`code channel ${c.channelId} conflicted but isn't recorded`);
  return { row: existing, created: false };
}

export async function getCodeChannel(channelId: string): Promise<CodeChannel | null> {
  const [row] = await sql<CodeChannel[]>`select * from code_channels where channel_id = ${channelId}`;
  return row ?? null;
}

export async function getCodeChannelBySession(sessionId: string): Promise<CodeChannel | null> {
  const [row] = await sql<CodeChannel[]>`select * from code_channels where session_id = ${sessionId}`;
  return row ?? null;
}

/** Code channels a thread opened (its children), newest first. */
export async function listChildCodeChannels(parentThreadId: string): Promise<CodeChannel[]> {
  return sql<CodeChannel[]>`select * from code_channels where parent_thread_id = ${parentThreadId} order by created_at desc`;
}

/**
 * Live (unarchived) channels with no activity for `idleMs`. `warned`: only ones already warned (true) / not yet
 * warned (false); omit for both. Oldest first.
 */
export async function listIdleCodeChannels(opts: { idleMs: number; warned?: boolean; closable?: boolean; limit?: number }): Promise<CodeChannel[]> {
  const secs = Math.floor(opts.idleMs / 1000);
  const warned = opts.warned === undefined ? sql`` : opts.warned ? sql`and warned_at is not null` : sql`and warned_at is null`;
  // `closable`: the sweep may try to close it now (not given up on, not backing off).
  const closable = opts.closable ? sql`and close_failures < ${CLOSE_MAX_ATTEMPTS} and (close_retry_at is null or close_retry_at <= now())` : sql``;
  return sql<CodeChannel[]>`
    select * from code_channels
    where archived_at is null and last_activity_at < now() - ${secs} * interval '1 second' ${warned} ${closable}
    order by last_activity_at limit ${opts.limit ?? 100}`;
}

/**
 * A message arrived: reset the idle clock (and the warning). Returns the state before the touch (to undo a
 * `suspended` warning status, or resume a reopened channel), or null for a channel that isn't a code channel.
 */
export async function touchCodeChannel(channelId: string): Promise<{ wasWarned: boolean; wasArchived: boolean } | null> {
  const [row] = await sql<{ wasWarned: boolean; wasArchived: boolean }[]>`
    update code_channels c set last_activity_at = now(), warned_at = null, closing_summary = null, close_failures = 0, close_retry_at = null
    from (select channel_id, warned_at is not null as was_warned, archived_at is not null as was_archived
          from code_channels where channel_id = ${channelId} for update) old
    where c.channel_id = old.channel_id
    returning old.was_warned, old.was_archived`;
  return row ?? null;
}

/**
 * The day-6 warning went out. False if it was already warned, archived, isn't recorded, or isn't idle for `idleMs`
 * any more (someone wrote in it since the sweep listed it).
 */
export async function markCodeChannelWarned(channelId: string, idleMs: number): Promise<boolean> {
  const secs = Math.floor(idleMs / 1000);
  const rows = await sql`
    update code_channels set warned_at = now()
    where channel_id = ${channelId} and warned_at is null and archived_at is null
      and last_activity_at <= now() - ${secs} * interval '1 second'
    returning channel_id`;
  return rows.length > 0;
}

/** Keep the closing summary a close wrote, for the next attempt if this one fails. */
export async function saveClosingSummary(channelId: string, summary: string, lastActivityAt?: Date): Promise<boolean> {
  const rows = await sql`
    update code_channels set closing_summary = ${summary}
    where channel_id = ${channelId} and archived_at is null
      ${lastActivityAt ? sql`and date_trunc('milliseconds', last_activity_at) = ${lastActivityAt}` : sql``}
    returning channel_id`;
  return rows.length > 0;
}

/**
 * A sweep close failed: count it and back off (2h, 4h, 8h, … before the next try); `final` (a refusal that won't
 * change) gives up at once. Returns the failures so far and whether the sweep has given up.
 */
export async function recordCloseFailure(channelId: string, o: { final: boolean }): Promise<{ failures: number; gaveUp: boolean }> {
  const [row] = await sql<{ closeFailures: number }[]>`
    update code_channels
    set close_failures = case when ${o.final} then ${CLOSE_MAX_ATTEMPTS} else least(close_failures + 1, ${CLOSE_MAX_ATTEMPTS}) end,
        close_retry_at = now() + power(2, least(close_failures + 1, 10)) * interval '1 hour'
    where channel_id = ${channelId}
    returning close_failures`;
  const failures = row?.closeFailures ?? CLOSE_MAX_ATTEMPTS;
  return { failures, gaveUp: failures >= CLOSE_MAX_ATTEMPTS };
}

/** Archived (by the sweep, /archive or a request). False if already archived or not recorded. */
export async function markCodeChannelArchived(channelId: string): Promise<boolean> {
  const rows = await sql`update code_channels set archived_at = now() where channel_id = ${channelId} and archived_at is null returning channel_id`;
  return rows.length > 0;
}

/** Reopened in Slack and posted in: live again, clock restarted. False if it wasn't archived. */
export async function unarchiveCodeChannel(channelId: string): Promise<boolean> {
  const rows = await sql`
    update code_channels set archived_at = null, warned_at = null, last_activity_at = now(),
                             closing_summary = null, close_failures = 0, close_retry_at = null
    where channel_id = ${channelId} and archived_at is not null returning channel_id`;
  if (rows.length) remember(channelId, true);
  return rows.length > 0;
}

/** The channel's first message was posted. */
export async function setCodeChannelSeedTs(channelId: string, seedTs: string): Promise<void> {
  await sql`update code_channels set seed_ts = ${seedTs} where channel_id = ${channelId}`;
}

// ---- retention and withdrawal ----------------------------------------------------------------------------------

/**
 * Retention step (runRetention): the seed summary, brief and closing summary of a channel idle past the window are
 * blanked (keyed on last activity, like a thread's own summary: a long-lived active channel keeps them), archived
 * channels idle past it are deleted. (Rows of channels whose conversation thread retention deleted already went by cascade.)
 */
export async function retainCodeChannels(retentionMs = limits.retentionMs): Promise<{ blanked: number; deleted: number }> {
  const secs = Math.floor(retentionMs / 1000);
  const blanked = await sql`
    update code_channels set seed_summary = null, brief = null, closing_summary = null
    where last_activity_at < now() - ${secs} * interval '1 second' and (seed_summary is not null or brief is not null or closing_summary is not null)
    returning channel_id`;
  const deleted = await sql`
    delete from code_channels where archived_at is not null and last_activity_at < now() - ${secs} * interval '1 second'
    returning channel_id`;
  for (const r of deleted) invalidateCodeChannelCache(r.channelId as string);
  return { blanked: blanked.length, deleted: deleted.length };
}

/**
 * Privacy withdrawal (handlePrivacyWithdraw): blank the seed summary and brief of every code channel they made or
 * asked for, or whose parent thread or conversation they wrote in (the same reach as thread summaries). Call it
 * before their stored messages are deleted. The rows stay (they say which channels are code channels).
 */
export async function forgetUserCodeChannelData(userId: string): Promise<number> {
  const rows = await sql`
    update code_channels c set seed_summary = null, brief = null, closing_summary = null
    where (c.seed_summary is not null or c.brief is not null or c.closing_summary is not null)
      and (c.created_by = ${userId} or c.requester_id = ${userId}
           or exists (select 1 from messages m where m.user_id = ${userId} and (m.thread_id = c.parent_thread_id or m.thread_id = c.thread_id)))
    returning channel_id`;
  return rows.length;
}
