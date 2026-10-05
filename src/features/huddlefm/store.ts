/** DJ sessions (dj_sessions, migration 190): one row per huddle channel while DJ mode is pending or active. */
import { limits } from '../../config.js';
import { sql } from '../../db/index.js';
import { capped, trackLabel, type HfmTrack } from './protocol.js';

export interface Playback {
  nowPlaying: string | null;
  /** Up next: "title - artist [trackId id]" plus "(autoplay)" for HuddleFM's own picks. */
  queue: string[];
  queueLength: number;
  at: string;
}

export interface DjSession {
  id: number;
  channelId: string;
  status: 'pending' | 'active';
  requestTs: string | null;
  requestedBy: string;
  originThreadId: string;
  autoDj: boolean;
  chatter: boolean;
  vibe: string | null;
  permissions: string[];
  picks: string[];
  requested: string[];
  skipped: string[];
  played: string[];
  playback: Playback | null;
  topupFailures: number;
  lastEventAt: Date | null;
  lastChatterAt: Date | null;
  lastNoticeAt: Date | null;
  grantedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A pending request older than this is dead (HuddleFM restarted, or we aren't allowlisted): treated as no session. */
export const isStalePending = (s: Pick<DjSession, 'status' | 'updatedAt'>, now = Date.now()) =>
  s.status === 'pending' && now - s.updatedAt.getTime() > limits.djPendingTimeoutMs;

export async function getSession(channelId: string): Promise<DjSession | null> {
  const [row] = await sql<DjSession[]>`select * from dj_sessions where channel_id = ${channelId}`;
  if (!row) return null;
  if (isStalePending(row)) {
    await sql`delete from dj_sessions where id = ${row.id} and status = 'pending'`;
    return null;
  }
  return row;
}

export async function findByRequestTs(requestTs: string): Promise<DjSession | null> {
  const [row] = await sql<DjSession[]>`select * from dj_sessions where request_ts = ${requestTs}`;
  return row ?? null;
}

/**
 * Sessions the agent should know about in this turn: the current channel's, the ones started from this thread, and
 * (in a DM) the ones the speaker started. Never other channels' sessions otherwise (their queues can be private).
 */
export async function sessionsForTurn(opts: { channelId: string; threadId: string; speakerId: string }): Promise<DjSession[]> {
  const isDm = opts.channelId.startsWith('D');
  const rows = await sql<DjSession[]>`
    select * from dj_sessions
    where channel_id = ${opts.channelId} or origin_thread_id = ${opts.threadId} or (${isDm}::boolean and requested_by = ${opts.speakerId})
    order by created_at desc limit 5`;
  return rows.filter((r) => !isStalePending(r));
}

export async function activeSessions(): Promise<DjSession[]> {
  return sql<DjSession[]>`select * from dj_sessions where status = 'active'`;
}

/** Start a pending request for a channel, replacing any older row (stale, or the caller checked it's not live). */
export async function createPending(o: { channelId: string; requestedBy: string; originThreadId: string; autoDj: boolean; chatter: boolean; vibe: string | null }): Promise<DjSession> {
  return sql.begin(async (tx) => {
    await tx`delete from dj_sessions where channel_id = ${o.channelId}`;
    const [row] = await tx<DjSession[]>`
      insert into dj_sessions (channel_id, status, requested_by, origin_thread_id, auto_dj, chatter, vibe)
      values (${o.channelId}, 'pending', ${o.requestedBy}, ${o.originThreadId}, ${o.autoDj}, ${o.chatter}, ${o.vibe})
      returning *`;
    return row!;
  });
}

export async function setRequestTs(id: number, requestTs: string) {
  await sql`update dj_sessions set request_ts = ${requestTs}, updated_at = now() where id = ${id} and status = 'pending'`;
}

export async function updateSettings(channelId: string, s: { autoDj?: boolean; chatter?: boolean; vibe?: string | null }): Promise<DjSession | null> {
  const [row] = await sql<DjSession[]>`
    update dj_sessions set
      auto_dj = coalesce(${s.autoDj ?? null}::boolean, auto_dj),
      chatter = coalesce(${s.chatter ?? null}::boolean, chatter),
      vibe = case when ${s.vibe !== undefined}::boolean then ${s.vibe ?? null}::text else vibe end,
      topup_failures = case when ${s.autoDj === true || s.vibe !== undefined}::boolean then 0 else topup_failures end,
      updated_at = now()
    where channel_id = ${channelId} returning *`;
  return row ?? null;
}

export function playbackFromStatus(status: Record<string, unknown>, now = new Date()): Playback {
  const queue = Array.isArray(status.queue) ? (status.queue as HfmTrack[]) : [];
  const now_ = status.nowPlaying && typeof status.nowPlaying === 'object' ? (status.nowPlaying as HfmTrack) : null;
  return {
    nowPlaying: now_ ? trackLabel(now_) || null : null,
    queue: queue.slice(0, limits.djSnapshotQueue).map((t) => `${trackLabel(t) || 'unknown'} [trackId ${t.id ?? '?'}]${t.automatic ? ' (autoplay)' : ''}`),
    queueLength: queue.length,
    at: now.toISOString(),
  };
}

export async function savePlayback(channelId: string, playback: Playback) {
  await sql`update dj_sessions set playback = ${sql.json(playback as any)}, last_event_at = now() where channel_id = ${channelId}`;
}

export type HistoryList = 'picks' | 'requested' | 'skipped' | 'played';

/** Append to one of the session's capped history lists (newest last, de-duplicated against the tail). */
export async function appendHistory(channelId: string, list: HistoryList, items: string[]): Promise<void> {
  const add = items.map((s) => s.trim()).filter(Boolean);
  if (!add.length) return;
  await sql.begin(async (tx) => {
    const [row] = await tx<{ list: string[] }[]>`select ${tx(list)} as list from dj_sessions where channel_id = ${channelId} for update`;
    if (!row) return;
    const kept = row.list.filter((s) => !add.includes(s));
    await tx`update dj_sessions set ${tx(list)} = ${capped(kept, add, limits.djHistory)}::text[] where channel_id = ${channelId}`;
  });
}

export async function touchEvent(channelId: string) {
  await sql`update dj_sessions set last_event_at = now() where channel_id = ${channelId}`;
}

/**
 * Auto DJ misses (a top-up that added nothing, or picks HuddleFM dropped): returns the new count. Only a pick that
 * actually starts playing resets it (resetTopupMisses), so a broken downloader keeps backing off instead of looping.
 */
export async function recordTopupMiss(channelId: string): Promise<number> {
  const [row] = await sql<{ topupFailures: number }[]>`
    update dj_sessions set topup_failures = topup_failures + 1 where channel_id = ${channelId} returning topup_failures`;
  return row?.topupFailures ?? 1;
}

export async function resetTopupMisses(channelId: string): Promise<void> {
  await sql`update dj_sessions set topup_failures = 0 where channel_id = ${channelId} and topup_failures <> 0`;
}
