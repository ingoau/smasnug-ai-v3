/**
 * Reminders: `set_reminder` / `list_reminders` / `cancel_reminder` (front agent; the owner is always the current
 * speaker) and the firing loop.
 *
 * Firing: Postgres is the source of truth and a 1-minute maintenance task polls it (no delayed BullMQ jobs to keep in
 * sync with cancels, restarts or Redis loss). A poller claims one due row at a time (`for update skip locked`,
 * status 'firing' + a claim id + a 5-minute lease), runs the entry checks and resolves the target outside any
 * transaction, then creates the turn and marks the row 'fired' in ONE transaction that also re-checks its claim. So
 * concurrent pollers never fire a row twice, and a crash mid-fire only means the lease runs out and the row is
 * retried (the DM fallback post is idempotent on the reminder id).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../../config.js';
import type { ToolContext } from '../../core/tools.js';
import { getUserInfo } from '../../context/users.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { slackCall } from '../../core/slack.js';
import { oneLine } from '../../agent/util.js';
import { sanitizeOutgoing } from '../send/logic.js';
import { ensureThreadRun } from '../../pipeline/scheduler.js';
import { createScheduledTurnTx, logScheduled, resolveDelivery } from './deliver.js';
import { formatDuration, formatInZone, resolveWhen } from './time.js';

export const MAX_FIRE_ATTEMPTS = 5;
/** Wait before the next attempt after a failed one (by attempt number), so a transient blip doesn't burn them all. */
export const RETRY_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
export const retryDelayMs = (attempt: number) => RETRY_BACKOFF_MS[Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1]!;
const LEASE = sql`interval '5 minutes'`;

export interface ReminderRow {
  id: number;
  ownerId: string;
  threadId: string;
  channelId: string;
  text: string;
  dueAt: Date;
  tz: string | null;
  status: string;
  skipReason: string | null;
  claimId: string | null;
  attempts: number;
  createdAt: Date;
}

const COLS = sql`id::int as id, owner_id, thread_id, channel_id, text, due_at, tz, status, skip_reason, claim_id, attempts, created_at`;

export const reminderLabel = (id: number) => `r_${id}`;

/** "r_12", "12", " R_12 " → 12. */
export function parseReminderId(raw: string): number | null {
  const m = /^\s*(?:r_?)?(\d{1,15})\s*$/i.exec(raw);
  return m ? Number(m[1]) : null;
}

/** Whether a listing in `currentChannel` may show text from an item created in `itemChannel` (privacy). */
export function canShowText(currentChannel: string, itemChannel: string): boolean {
  return currentChannel.startsWith('D') || currentChannel === itemChannel;
}

// ---------- tools ----------

export async function setReminder(ctx: ToolContext, input: { text: string; at?: string; in?: string }): Promise<string> {
  const text = input.text.trim();
  if (!text) return 'The reminder text is empty.';
  const tz = (await getUserInfo(ctx.speakerId).catch(() => null))?.tz;
  const now = Date.now();
  const when = resolveWhen(input, { now, tz, maxAheadMs: limits.reminderMaxAheadMs });
  if (!when.ok) return when.error;

  // Cap check, duplicate check and insert under a per-owner lock: concurrent calls can't exceed the cap.
  const res = await sql.begin(async (tx): Promise<{ id: number; dupe: boolean } | { full: number }> => {
    await tx`select pg_advisory_xact_lock(hashtext('reminders:owner'), hashtext(${ctx.speakerId}))`;
    // A retried / repeated call in the same thread for the same text and time reuses the reminder.
    const [dupe] = await tx<{ id: number }[]>`
      select id::int as id from reminders where owner_id = ${ctx.speakerId} and thread_id = ${ctx.threadId} and text = ${text}
        and due_at = ${when.due} and status = 'pending'`;
    if (dupe) return { id: dupe.id, dupe: true };
    const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
      select count(*)::int as n from reminders where owner_id = ${ctx.speakerId} and status in ('pending', 'firing')`;
    if (n >= limits.userPendingReminders) return { full: n };
    const [row] = await tx<{ id: number }[]>`
      insert into reminders (owner_id, thread_id, channel_id, text, due_at, tz)
      values (${ctx.speakerId}, ${ctx.threadId}, ${ctx.channelId}, ${text}, ${when.due}, ${tz ?? null})
      returning id::int as id`;
    return { id: row!.id, dupe: false };
  });
  if ('full' in res)
    return `Limit reached: this user already has ${res.full} pending reminders (max ${limits.userPendingReminders}). They can cancel some first (list_reminders).`;
  const { id, dupe } = res;
  if (!dupe) await logScheduled(ctx.threadId, 'reminder_set', ctx.speakerId, { reminderId: id, dueAt: when.due.toISOString(), turnId: ctx.turnId ?? null });
  const zoneNote = tz ? '' : ' (their time zone is unknown, so times without an offset were read as UTC)';
  const where = ctx.channelId.startsWith('D') ? 'in this DM' : 'in this thread';
  return (
    `${dupe ? 'Already set' : 'Reminder set'}: ${reminderLabel(id)} for ${formatInZone(when.due, tz)}, in ${formatDuration(when.due.getTime() - now)}${zoneNote}. ` +
    `When it's due you'll get a turn ${where} to ping <@${ctx.speakerId}> (and do any lookup it asks for). ` +
    'Confirm the resolved day and time briefly in your reply, in their local time (e.g. "ok, fri 9am").'
  );
}

export async function listReminders(ctx: ToolContext): Promise<string> {
  const rows = await sql<ReminderRow[]>`
    select ${COLS} from reminders where owner_id = ${ctx.speakerId} and status in ('pending', 'firing') order by due_at limit 50`;
  if (!rows.length) return 'The speaker has no pending reminders.';
  const tz = (await getUserInfo(ctx.speakerId).catch(() => null))?.tz ?? rows[0]!.tz ?? undefined;
  const lines = rows.map((r) => {
    const what = canShowText(ctx.channelId, r.channelId) ? `"${r.text}"` : '(set in another conversation; text hidden here, ask in a DM to see it)';
    return `- ${reminderLabel(r.id)} ${formatInZone(r.dueAt, tz)}: ${what}`;
  });
  return `Pending reminders of <@${ctx.speakerId}> (${rows.length}/${limits.userPendingReminders}):\n${lines.join('\n')}`;
}

export async function cancelReminder(ctx: ToolContext, rawId: string): Promise<string> {
  const id = parseReminderId(rawId);
  if (id == null) return `"${rawId}" is not a reminder id (like r_12). Use list_reminders.`;
  const [row] = await sql<{ id: number }[]>`
    update reminders set status = 'cancelled', updated_at = now()
    where id = ${id} and owner_id = ${ctx.speakerId} and status = 'pending' returning id::int as id`;
  if (row) {
    await logScheduled(ctx.threadId, 'reminder_cancelled', ctx.speakerId, { reminderId: id });
    return `Cancelled ${reminderLabel(id)}.`;
  }
  // Only the owner learns anything about a reminder.
  const [cur] = await sql<{ status: string }[]>`select status from reminders where id = ${id} and owner_id = ${ctx.speakerId}`;
  if (!cur) return `The speaker has no reminder ${reminderLabel(id)}. Use list_reminders.`;
  return `${reminderLabel(id)} can't be cancelled: it is already ${cur.status === 'firing' ? 'firing right now' : cur.status}.`;
}

export function reminderTools(ctx: ToolContext) {
  return {
    set_reminder: tool({
      description:
        'Set a reminder for the current speaker (only for themselves). When it is due you get a turn in this thread to ping them ' +
        'and can do any work it asks for (e.g. "check the release"). Give exactly one of `at` or `in`. Precision ~1 minute, max 1 year ahead.',
      inputSchema: z.object({
        text: z.string().min(1).max(limits.reminderTextMaxChars).describe('What to remind them about / what to do then, in their words'),
        at: z
          .string()
          .optional()
          .describe('ISO-8601 local date-time, e.g. "2026-10-09T09:00" (read in the speaker\'s time zone) or with an offset "2026-10-09T09:00+02:00"'),
        in: z.string().optional().describe('Relative duration, e.g. "20m", "2h30m", "3 days", "1 week", or ISO "PT2H"'),
      }),
      execute: (input) => setReminder(ctx, input),
    }),
    list_reminders: tool({
      description: "List the current speaker's pending reminders (ids, due times).",
      inputSchema: z.object({}),
      execute: () => listReminders(ctx),
    }),
    cancel_reminder: tool({
      description: "Cancel one of the current speaker's own pending reminders by id (e.g. r_12).",
      inputSchema: z.object({ id: z.string().describe('Reminder id, e.g. r_12') }),
      execute: ({ id }) => cancelReminder(ctx, id),
    }),
  };
}

// ---------- firing ----------

/** Claim one due reminder (or one whose lease ran out) for this poller. */
export async function claimDueReminder(): Promise<(ReminderRow & { claimId: string }) | null> {
  const [row] = await sql<(ReminderRow & { claimId: string })[]>`
    update reminders set status = 'firing', claim_id = gen_random_uuid(), claimed_until = now() + ${LEASE},
      attempts = attempts + 1, updated_at = now()
    where id = (
      select id from reminders
      where (status = 'pending' and coalesce(retry_at, due_at) <= now()) or (status = 'firing' and claimed_until < now())
      order by coalesce(retry_at, due_at) limit 1 for update skip locked)
    returning ${COLS}`;
  return row ?? null;
}

/** End a claim without firing (skipped / failed / back to pending, due again in `retryInMs`), only if we still hold it. */
async function releaseClaim(r: { id: number; claimId: string }, status: 'skipped' | 'failed' | 'pending', reason: string | null, retryInMs = 0) {
  const rows = await sql`
    update reminders set status = ${status}, skip_reason = ${reason}, claim_id = null, claimed_until = null, updated_at = now(),
      retry_at = case when ${status === 'pending'} then now() + ${retryInMs / 1000} * interval '1 second' else retry_at end
    where id = ${r.id} and claim_id = ${r.claimId} and status = 'firing' returning id`;
  return rows.length > 0;
}

/** A reminder that finally failed: tell the owner in a short plain DM (best effort, once per reminder). */
async function notifyFailed(r: ReminderRow) {
  try {
    const open = await slackCall<any>('conversations.open', { users: r.ownerId });
    const dm: string | undefined = open.channel?.id;
    if (!dm) return;
    const text = `⏰ Sorry, I couldn't deliver a reminder you set for ${formatInZone(r.dueAt, r.tz ?? undefined)}: "${sanitizeOutgoing(oneLine(r.text, 300))}"`;
    await slackCall('chat.postMessage', { channel: dm, text, unfurl_links: false }, { idempotencyKey: `reminder-failed:${r.id}` });
  } catch (err) {
    log.warn({ err, reminderId: r.id }, 'reminder failure note failed');
  }
}

async function fail(r: ReminderRow & { claimId: string }, reason: string) {
  if (await releaseClaim(r, 'failed', reason)) {
    await logScheduled(r.threadId, 'reminder_failed', 'system', { reminderId: r.id, reason });
    await notifyFailed(r);
  }
}

export function renderReminderInput(r: Pick<ReminderRow, 'id' | 'ownerId' | 'text' | 'dueAt' | 'createdAt' | 'tz'>, fallback: false | 'gone' | 'unavailable'): string {
  const where = fallback
    ? `The thread where they set it ${fallback === 'gone' ? 'no longer exists' : "can't be used any more (you're not active in that channel now)"}, so this runs in a DM with them (the DM starts with a short "reminder" note from you).`
    : 'This is the thread where they set it.';
  return [
    `<reminder id="${reminderLabel(r.id)}" owner="<@${r.ownerId}>" set="${formatInZone(r.createdAt, r.tz ?? undefined)}" due="${formatInZone(r.dueAt, r.tz ?? undefined)}">`,
    r.text,
    '</reminder>',
    `This turn was started by a reminder <@${r.ownerId}> set earlier, not by a new message. It is due now. ${where} ` +
      `Reply once: @mention <@${r.ownerId}> and remind them in your own voice, short and natural. If the reminder asks you to check, ` +
      'look up or do something, do that first with your tools and include what you found. Only set another reminder if the reminder text asks to repeat.',
  ].join('\n');
}

/** Fire one claimed reminder. Exactly once: the turn insert and the 'fired' mark commit together under our claim. */
export async function fireReminder(r: ReminderRow & { claimId: string }): Promise<'fired' | 'skipped' | 'failed' | 'lost'> {
  if (r.attempts > MAX_FIRE_ATTEMPTS) {
    await fail(r, 'too_many_attempts');
    return 'failed';
  }
  try {
    const delivery = await resolveDelivery({
      ownerId: r.ownerId,
      threadId: r.threadId,
      channelId: r.channelId,
      idempotencyKey: `reminder-dm:${r.id}`,
      rootText: (why) => `⏰ Reminder for <@${r.ownerId}> (${why === 'gone' ? 'the thread you set it in was deleted' : "I can't post in the channel you set it in right now"})`,
    });
    if ('skip' in delivery) {
      // Pause / suspension / a deactivated owner: dropped on purpose (not retried later), see docs/design.md.
      await releaseClaim(r, 'skipped', delivery.skip);
      log.info({ reminderId: r.id, reason: delivery.skip }, 'reminder skipped');
      await logScheduled(r.threadId, 'reminder_skipped', 'system', { reminderId: r.id, reason: delivery.skip });
      return 'skipped';
    }
    const { target } = delivery;
    const input = renderReminderInput(r, delivery.why ?? false);
    const turnId = await sql.begin(async (tx) => {
      const [cur] = await tx<{ status: string; claimId: string | null }[]>`select status, claim_id from reminders where id = ${r.id} for update`;
      if (!cur || cur.status !== 'firing' || cur.claimId !== r.claimId) return null;
      const id = await createScheduledTurnTx(tx, { threadId: target.threadId, ownerId: r.ownerId, source: 'reminder', sourceId: r.id, input, isMention: true });
      await tx`
        update reminders set status = 'fired', turn_id = ${id}, fired_thread_id = ${target.threadId}, fired_at = now(),
          claim_id = null, claimed_until = null, skip_reason = null, updated_at = now()
        where id = ${r.id}`;
      return id;
    });
    if (turnId == null) return 'lost';
    await ensureThreadRun(target.threadId);
    await logScheduled(target.threadId, 'reminder_fired', 'system', { reminderId: r.id, turnId, fallback: target.fallback });
    return 'fired';
  } catch (err) {
    log.error({ err, reminderId: r.id, attempt: r.attempts }, 'reminder fire failed');
    if (r.attempts >= MAX_FIRE_ATTEMPTS) await fail(r, 'error').catch(() => {});
    else await releaseClaim(r, 'pending', 'error', retryDelayMs(r.attempts)).catch(() => {});
    return 'failed';
  }
}

/** Maintenance task (every minute): fire everything that is due, one claim at a time, within a time budget. */
export async function fireDueReminders(opts: { max?: number; budgetMs?: number } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  let n = 0;
  while (n < (opts.max ?? 100) && Date.now() < deadline) {
    const r = await claimDueReminder();
    if (!r) break;
    await fireReminder(r);
    n++;
  }
  return n;
}
