/**
 * A code channel's lifecycle (docs/code-channels.md, Slash commands / Lifecycle): its slash commands, the closing
 * flow (closing summary → parent thread → `agents.conversations.archive`), renaming, the idle sweep and reopening.
 *
 * - `/archive` (any member), the `archive_code_channel` tool and the day-7 sweep share `closeCodeChannel`.
 * - `/rename <title>` renames the session and the channel ("<bot name>: <title>", like creation).
 * - The sweep (hourly maintenance): day 6 idle → a warning and `suspended`; day 7 idle, warned at least a day
 *   earlier → closed. Any message resets the clock (store.ts touchCodeChannel clears the warning).
 * - Reopening: `channel_unarchive` / `group_unarchive` (or a message in a channel marked archived, intake) makes the
 *   row live again and restarts the clock.
 */
import { env } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { appendEvent, codeChannelThreadId, parseThreadId } from '../../core/events.js';
import { isThreadGone, slackCall, slackErrorCode } from '../../core/slack.js';
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { neutralizeBroadcasts } from '../../pipeline/guidelines.js';
import { restoreSessionStatus } from '../../pipeline/agent-session.js';
import { setSessionStatus } from '../../pipeline/session-status.js';
import { ephemeral } from '../util.js';
import { archiveCodeChannel, renameCodeChannel } from './api.js';
import { CodeChannelError } from './errors.js';
import { codeChannelDisplayName } from './ids.js';
import { postInThread } from './open.js';
import { generateClosingSummary } from './seed.js';
import { codeChannelsEnabled } from './settings.js';
import {
  getCodeChannel,
  invalidateCodeChannelCache,
  isCodeChannel,
  listIdleCodeChannels,
  markCodeChannelArchived,
  markCodeChannelWarned,
  unarchiveCodeChannel,
  type CodeChannel,
} from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Idle this long: the warning. */
export const WARN_AFTER_MS = 6 * DAY_MS;
/** Idle this long (and warned at least ARCHIVE_AFTER_MS − WARN_AFTER_MS ago): archived. */
export const ARCHIVE_AFTER_MS = 7 * DAY_MS;

// ---- slash commands --------------------------------------------------------------------------------------------

/** Why a slash command can't run here, or null when it can (a live code channel, feature on). */
async function slashRefusal(channelId: string | undefined): Promise<string | null> {
  if (!channelId || !(await codeChannelsEnabled()) || !(await isCodeChannel(channelId))) return 'That command only works in a code channel.';
  return null;
}

/** `/archive` (any member): closing summary, parent thread, archive. The ack was sent by ingress; this runs async. */
export async function handleArchiveSlash(ctx: ActionContext): Promise<void> {
  const refusal = await slashRefusal(ctx.channelId);
  if (refusal) return ephemeral(ctx, refusal);
  const res = await closeCodeChannel({
    channelId: ctx.channelId!,
    actor: ctx.userId,
    reason: 'command',
    attemptKey: `slash:${ctx.triggerId ?? `${ctx.userId}:${Date.now()}`}`,
  });
  if (!res.ok) await ephemeral(ctx, res.text);
}

/** `/rename <title>`: agents.sessions.rename ("<bot name>: <title>") and the row's name. */
export async function handleRenameSlash(ctx: ActionContext): Promise<void> {
  const refusal = await slashRefusal(ctx.channelId);
  if (refusal) return ephemeral(ctx, refusal);
  const raw = String(ctx.value ?? '').trim();
  if (!raw) return ephemeral(ctx, 'Usage: `/rename <new title>`');
  const res = await renameChannel(ctx.channelId!, raw, ctx.userId);
  await ephemeral(ctx, res.text);
}

/** Rename a code channel (session title + channel name). */
export async function renameChannel(channelId: string, title: string, actor: string | null): Promise<{ ok: boolean; text: string }> {
  const row = await getCodeChannel(channelId);
  if (!row) return { ok: false, text: "That isn't a code channel." };
  if (row.archivedAt) return { ok: false, text: 'This channel is archived.' };
  const name = codeChannelDisplayName(title.replace(/<[^>]*>/g, ' '), env.BOT_DISPLAY_NAME);
  try {
    await renameCodeChannel(channelId, name);
  } catch (err) {
    return { ok: false, text: err instanceof CodeChannelError ? err.userMessage : "Slack didn't rename it." };
  }
  await sql`update code_channels set name = ${name} where channel_id = ${channelId}`;
  await appendEvent(codeChannelThreadId(channelId), 'code_channel_renamed', actor, { name }).catch(() => {});
  return { ok: true, text: `Renamed to "${name}".` };
}

// ---- closing ---------------------------------------------------------------------------------------------------

export type CloseReason = 'command' | 'agent' | 'sweep';

export interface CloseInput {
  channelId: string;
  /** Who asked (a person), or null for the sweep. */
  actor: string | null;
  reason: CloseReason;
  /**
   * The archive attempt (the slash invocation, the turn, the sweep's warning): every post and the archive call are
   * keyed by it, so a retried attempt posts nothing twice.
   */
  attemptKey: string;
  abortSignal?: AbortSignal;
}

export type CloseResult = { ok: true; summaryTs: string | null; alreadyArchived: boolean } | { ok: false; text: string };

/** The fallback when the summary can't be written. */
const NO_SUMMARY = '_(The closing summary could not be written.)_';

/** The closing message in the channel. Pure. */
export function closingText(o: { summary: string | null; reason: CloseReason; actor: string | null }): string {
  const why =
    o.reason === 'sweep' ? 'Archiving this channel after a week without messages.' : o.actor ? `<@${o.actor}> asked to archive this channel.` : 'Archiving this channel.';
  return `*Closing summary*\n${o.summary?.trim() || NO_SUMMARY}\n\n_${why} Unarchive it to pick up where it left off._`;
}

/** The parent thread's line. Pure. */
export function parentClosingText(o: { channelId: string; summary: string | null }): string {
  return `<#${o.channelId}> finished: ${o.summary?.trim() || NO_SUMMARY}`;
}

/** The day-6 warning. Pure. */
export function warningText(): string {
  return "This channel has been quiet for 6 days. I'll post a closing summary and archive it tomorrow unless someone writes here. (`/archive` does it now.)";
}

/** The parent thread can still be posted in (not deleted). */
async function parentThreadAlive(threadId: string): Promise<boolean> {
  const { channelId, threadTs } = parseThreadId(threadId);
  const [t] = await sql<{ rootDeletedAt: Date | null }[]>`select root_deleted_at from threads where id = ${threadId}`;
  if (t?.rootDeletedAt) return false;
  return !(await isThreadGone(channelId, threadTs).catch(() => false));
}

/**
 * Close a code channel: one closing summary (a model call over its conversation) posted top level in the channel,
 * then into the parent thread (if it still exists) as "<channel> finished: …", then agents.conversations.archive with
 * the summary's ts; the row is marked archived and the session `closed`. One close at a time per channel (a Redis
 * lock); an archived row is left alone. Never throws.
 */
export async function closeCodeChannel(i: CloseInput): Promise<CloseResult> {
  const lockKey = `lock:code-channel-close:${i.channelId}`;
  let locked = false;
  try {
    locked = (await redis.set(lockKey, i.attemptKey, 'PX', 5 * 60_000, 'NX')) === 'OK';
    if (!locked) return { ok: false, text: 'This channel is being archived already.' };
    const row = await getCodeChannel(i.channelId);
    if (!row) return { ok: false, text: "That isn't a code channel." };
    if (row.archivedAt) return { ok: false, text: 'This channel is already archived.' };
    return await close(row, i);
  } catch (err) {
    log.error({ err, channelId: i.channelId }, 'closing a code channel failed');
    return { ok: false, text: `Archiving failed: ${err instanceof CodeChannelError ? err.userMessage : `Slack error ${slackErrorCode(err) ?? 'unknown'}.`}` };
  } finally {
    if (locked) await redis.del(lockKey).catch(() => {});
  }
}

async function close(row: CodeChannel, i: CloseInput): Promise<CloseResult> {
  const threadId = row.threadId;
  const summary = await generateClosingSummary({ threadId, userId: i.actor ?? row.requesterId, ...(i.abortSignal ? { abortSignal: i.abortSignal } : {}) }).catch((err) => {
    log.warn({ err, channelId: row.channelId }, 'closing summary failed');
    return null;
  });
  const clean = summary ? neutralizeBroadcasts(summary) : null;
  const key = `cc-close:${row.channelId}:${i.attemptKey}`;
  let summaryTs: string | null = null;
  try {
    const res = await slackCall<any>(
      'chat.postMessage',
      { channel: row.channelId, text: neutralizeBroadcasts(closingText({ summary: clean, reason: i.reason, actor: i.actor })), unfurl_links: false },
      { idempotencyKey: `${key}:summary` },
    );
    summaryTs = res?.ts ? String(res.ts) : null;
  } catch (err) {
    log.warn({ err, channelId: row.channelId }, 'closing summary post failed');
  }
  if (row.parentThreadId && (await parentThreadAlive(row.parentThreadId))) {
    await postInThread(row.parentThreadId, parentClosingText({ channelId: row.channelId, summary: clean }), `${key}:parent`)
      .then(() => appendEvent(row.parentThreadId!, 'code_channel_closed', i.actor, { channelId: row.channelId, reason: i.reason }))
      .catch((err) => log.warn({ err, channelId: row.channelId }, 'closing summary to the parent thread failed'));
  }
  const { alreadyArchived } = await archiveCodeChannel({ channelId: row.channelId, ...(summaryTs ? { summaryMessageTs: summaryTs } : {}), idempotencyKey: `${row.channelId}:${i.attemptKey}` });
  await markArchived(row.channelId, i.actor, { reason: i.reason, summaryTs, alreadyArchived });
  return { ok: true, summaryTs, alreadyArchived };
}

/** Mark the row archived (once), record it and set the session `closed`. */
async function markArchived(channelId: string, actor: string | null, payload: Record<string, unknown>): Promise<void> {
  if (!(await markCodeChannelArchived(channelId))) return;
  invalidateCodeChannelCache(channelId);
  await appendEvent(codeChannelThreadId(channelId), 'code_channel_archived', actor, payload).catch(() => {});
  await setSessionStatus(channelId, '0', 'closed').catch(() => {});
  log.info({ channelId, ...payload }, 'code channel archived');
}

// ---- the sweep -------------------------------------------------------------------------------------------------

export type SweepAction = 'warn' | 'archive' | null;

/**
 * What the sweep does with a live row (pure): idle ≥ 6 days and not warned → warn; idle ≥ 7 days and warned at least
 * a day ago → archive (a sweep that was down doesn't archive an hour after the warning).
 */
export function sweepAction(row: Pick<CodeChannel, 'lastActivityAt' | 'warnedAt' | 'archivedAt'>, now: Date): SweepAction {
  if (row.archivedAt) return null;
  const idle = now.getTime() - new Date(row.lastActivityAt).getTime();
  if (!row.warnedAt) return idle >= WARN_AFTER_MS ? 'warn' : null;
  const warnedFor = now.getTime() - new Date(row.warnedAt).getTime();
  return idle >= ARCHIVE_AFTER_MS && warnedFor >= ARCHIVE_AFTER_MS - WARN_AFTER_MS ? 'archive' : null;
}

/** Maintenance (hourly): warn and archive idle code channels. Inert while the feature is off. */
export async function sweepCodeChannels(now = new Date()): Promise<{ warned: number; archived: number }> {
  const out = { warned: 0, archived: 0 };
  if (!(await codeChannelsEnabled())) return out;
  for (const row of await listIdleCodeChannels({ idleMs: WARN_AFTER_MS, warned: false })) {
    if (sweepAction(row, now) !== 'warn') continue;
    try {
      await slackCall('chat.postMessage', { channel: row.channelId, text: warningText(), unfurl_links: false }, { idempotencyKey: `cc-warn:${row.channelId}:${new Date(row.lastActivityAt).getTime()}` });
      if (!(await markCodeChannelWarned(row.channelId))) continue;
      await appendEvent(row.threadId, 'code_channel_warned', null, {}).catch(() => {});
      await setSessionStatus(row.channelId, '0', 'suspended').catch(() => {});
      out.warned++;
    } catch (err) {
      log.warn({ err, channelId: row.channelId }, 'code channel idle warning failed');
      if (slackErrorCode(err) === 'is_archived' || slackErrorCode(err) === 'channel_not_found') await markArchived(row.channelId, null, { reason: 'gone' });
    }
  }
  for (const row of await listIdleCodeChannels({ idleMs: ARCHIVE_AFTER_MS, warned: true })) {
    if (sweepAction(row, now) !== 'archive') continue;
    const res = await closeCodeChannel({ channelId: row.channelId, actor: null, reason: 'sweep', attemptKey: `sweep:${new Date(row.warnedAt!).getTime()}` });
    if (res.ok) out.archived++;
  }
  if (out.warned || out.archived) log.info(out, 'code channel sweep');
  return out;
}

// ---- archive / unarchive events ------------------------------------------------------------------------------

/**
 * `channel_archive` / `group_archive`: a code channel archived in Slack (by us or by a person): the row is marked
 * archived and the session closed. `channel_unarchive` / `group_unarchive`: reopened, so the row is live again, the
 * clock restarts and the session goes back to its resting status. Never throws.
 */
export async function handleCodeChannelArchiveEvent(ev: { type?: string; channel?: unknown; user?: unknown }): Promise<void> {
  const channelId = typeof ev.channel === 'string' ? ev.channel : null;
  if (!channelId) return;
  try {
    if (!(await codeChannelsEnabled()) || !(await isCodeChannel(channelId))) return;
    const actor = typeof ev.user === 'string' ? ev.user : null;
    if (ev.type === 'channel_archive' || ev.type === 'group_archive') return await markArchived(channelId, actor, { reason: 'slack' });
    if (!(await unarchiveCodeChannel(channelId))) return;
    const threadId = codeChannelThreadId(channelId);
    await appendEvent(threadId, 'code_channel_reopened', actor, { via: ev.type }).catch(() => {});
    log.info({ channelId }, 'code channel reopened');
    await restoreSessionStatus(threadId);
  } catch (err) {
    log.warn({ err, channelId, type: ev.type }, 'code channel archive event failed');
  }
}
