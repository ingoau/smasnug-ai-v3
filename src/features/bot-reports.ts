/**
 * report_user: the front agent quietly reports the CURRENT speaker to the moderators (misuse, harassment, scams,
 * self-harm concerns…). Takes no user id, so the bot can't be steered into reporting third parties. Nothing is shown
 * in the user's thread. Reports go to MOD_CHANNEL_ID with moderation buttons and are stored in `bot_reports`.
 * Bot reports never count towards auto-suspension (that stays human-reports-only); a reviewer can suspend by hand.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { appendEvent } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { registerTool, type ToolContext } from '../core/tools.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { EXTRAS, getExtra } from '../tools/extras.js';
import { normalizeTs } from '../tools/util.js';
import { confirmDialog, modNote } from './reports.js';
import { sanitizeOutgoing } from './send/logic.js';
import { setBlock } from './state.js';
import { isAdmin, mrkdwnEscape, postToModChannel, quote, requireAdmin, truncate } from './util.js';

export const BOT_REPORT_CATEGORIES = [
  'harassment',
  'threats_or_violence',
  'sexual_content',
  'scam_or_phishing',
  'doxxing_or_privacy',
  'impersonation',
  'spam_or_abuse_of_bot',
  'self_harm_concern',
  'other',
] as const;
export type BotReportCategory = (typeof BOT_REPORT_CATEGORIES)[number];

export const BOT_REPORT_LIMITS = {
  /** At most one report per (user, thread) in this window. */
  perThreadWindowMs: 60 * 60 * 1000,
  /** At most this many reports per user per rolling day. */
  perUserPerDay: 5,
  reasonMax: 500,
  /** Shown in the mod channel. */
  snapshotMax: 1500,
  /** Stored. */
  snapshotStoreMax: 4000,
};

export const ALREADY_REPORTED = 'Already reported.';
export const REPORTED = 'Reported to moderators.';

const CATEGORY_LABELS: Record<BotReportCategory, string> = {
  harassment: 'Harassment',
  threats_or_violence: 'Threats or violence',
  sexual_content: 'Sexual content',
  scam_or_phishing: 'Scam or phishing',
  doxxing_or_privacy: 'Doxxing / privacy',
  impersonation: 'Impersonation',
  spam_or_abuse_of_bot: 'Spam / abuse of the bot',
  self_harm_concern: 'Self-harm concern',
  other: 'Other',
};

export function reportUserTool(ctx: ToolContext) {
  return tool({
    description:
      'Quietly report the CURRENT speaker to the human moderators. Nothing is posted in the thread and the speaker is not told. ' +
      'Use only for clear misuse (see Safety), at most once per conversation, then carry on normally.',
    inputSchema: z.object({
      reason: z.string().min(1).max(2000).describe('Short factual description of what they did or asked for (max 500 chars)'),
      category: z.enum(BOT_REPORT_CATEGORIES),
      message_ts: z.string().optional().describe("ts of the speaker's offending message; defaults to their latest message"),
    }),
    execute: async ({ reason, category, message_ts }) => {
      try {
        return await fileBotReport(ctx, { reason, category, messageTs: message_ts });
      } catch (err) {
        log.error({ err, threadId: ctx.threadId }, 'report_user failed');
        return 'Report failed. Carry on normally.';
      }
    },
  });
}

/** Pure: may another report about this user be filed now? */
export function botReportAllowed(o: { reportsInThreadWithinWindow: number; reportsToday: number }) {
  return o.reportsInThreadWithinWindow === 0 && o.reportsToday < BOT_REPORT_LIMITS.perUserPerDay;
}

interface Target {
  ts: string;
  text: string | null;
}

/** The speaker's message to snapshot: the given ts if it is theirs, else the turn's latest triggering message. */
async function resolveTarget(ctx: ToolContext, explicitTs: string | undefined): Promise<Target | undefined> {
  const own = async (ts: string | undefined): Promise<Target | undefined> => {
    if (!ts) return undefined;
    const [m] = await sql<{ userId: string | null; text: string; deleted: boolean }[]>`
      select user_id, text, deleted from messages where channel_id = ${ctx.channelId} and ts = ${ts}`;
    if (!m || m.userId !== ctx.speakerId) return undefined;
    return { ts, text: m.deleted ? null : m.text };
  };
  const fallbackTs = getExtra(ctx.extras, EXTRAS.defaultReactTs);
  return (await own(normalizeTs(explicitTs))) ?? (await own(fallbackTs)) ?? (fallbackTs ? { ts: fallbackTs, text: null } : undefined);
}

async function permalink(channel: string, ts: string): Promise<string | null> {
  return slackCall<any>('chat.getPermalink', { channel, message_ts: ts })
    .then((r) => (r.permalink as string | undefined) ?? null)
    .catch(() => null);
}

async function counts(userId: string, threadId: string, q: typeof sql = sql) {
  const [r] = await q<{ inThread: number; today: number }[]>`
    select
      count(*) filter (where thread_id = ${threadId} and created_at > now() - ${BOT_REPORT_LIMITS.perThreadWindowMs / 1000} * interval '1 second')::int as in_thread,
      count(*)::int as today
    from bot_reports where user_id = ${userId} and created_at > now() - interval '1 day'`;
  return { reportsInThreadWithinWindow: r?.inThread ?? 0, reportsToday: r?.today ?? 0 };
}

export async function fileBotReport(
  ctx: ToolContext,
  input: { reason: string; category: BotReportCategory; messageTs?: string },
): Promise<string> {
  const userId = ctx.speakerId;
  const target = await resolveTarget(ctx, input.messageTs);
  const idempotencyKey = `${ctx.threadId}:${ctx.turnId != null ? `turn:${ctx.turnId}` : `ts:${target?.ts ?? 'none'}`}`;

  // Cheap pre-check before the Slack calls; re-checked under the lock below.
  const [dupe] = await sql`select 1 from bot_reports where idempotency_key = ${idempotencyKey}`;
  if (dupe || !botReportAllowed(await counts(userId, ctx.threadId))) return ALREADY_REPORTED;

  const messageLink = target ? await permalink(ctx.channelId, target.ts) : null;
  const threadLink = target?.ts === ctx.threadTs ? null : await permalink(ctx.channelId, ctx.threadTs);
  const reason = truncate(input.reason.trim(), BOT_REPORT_LIMITS.reasonMax);
  const snapshot = target?.text != null ? truncate(target.text, BOT_REPORT_LIMITS.snapshotStoreMax) : null;

  const reportId = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`bot_report:${userId}`}))`;
    if (!botReportAllowed(await counts(userId, ctx.threadId, tx as unknown as typeof sql))) return null;
    const [row] = await tx<{ id: string }[]>`
      insert into bot_reports (user_id, category, reason, channel_id, message_ts, thread_id, permalink, snapshot, idempotency_key)
      values (${userId}, ${input.category}, ${reason}, ${ctx.channelId}, ${target?.ts ?? null}, ${ctx.threadId},
              ${messageLink}, ${snapshot}, ${idempotencyKey})
      on conflict (idempotency_key) do nothing returning id`;
    return row ? Number(row.id) : null;
  });
  if (reportId == null) return ALREADY_REPORTED;

  await appendEvent(ctx.threadId, 'bot_report', 'bot', {
    reportId,
    userId,
    category: input.category,
    messageTs: target?.ts ?? null,
    turnId: ctx.turnId ?? null,
  }).catch((err) => log.warn({ err }, 'bot_report event append failed'));

  try {
    await postToModChannel(
      `🚩 Report filed by ${env.BOT_DISPLAY_NAME} about <@${userId}>`,
      botReportBlocks({
        reportId,
        userId,
        category: input.category,
        reason,
        snapshot,
        channelId: ctx.channelId,
        permalink: messageLink,
        threadLink,
      }),
      `bot-report:${reportId}`,
    );
  } catch (err) {
    log.error({ err, reportId }, 'posting bot report to mod channel failed');
  }
  return REPORTED;
}

/** Pure: the mod-channel message for a bot report. */
export function botReportBlocks(o: {
  reportId: number;
  userId: string;
  category: BotReportCategory;
  reason: string;
  snapshot: string | null;
  channelId: string;
  permalink: string | null;
  threadLink: string | null;
}): unknown[] {
  const safe = (s: string) => mrkdwnEscape(sanitizeOutgoing(s));
  const where = /^D/.test(o.channelId) ? 'a DM with the bot' : `<#${o.channelId}>`;
  const links = [where, o.permalink && `<${o.permalink}|Open message>`, o.threadLink && `<${o.threadLink}|Open thread>`, `bot report #${o.reportId}`]
    .filter(Boolean)
    .join(' · ');
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🚩 *Report filed by ${mrkdwnEscape(env.BOT_DISPLAY_NAME)} about <@${o.userId}>*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Category:* ${CATEGORY_LABELS[o.category] ?? o.category}\n*Reason:* ${safe(o.reason)}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: o.snapshot
          ? `*Reported message:*\n${quote(sanitizeOutgoing(o.snapshot), BOT_REPORT_LIMITS.snapshotMax)}`
          : '*Reported message:* _not available_',
      },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${links}\nBot reports don't count towards auto-suspension.` }] },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'mod:suspend',
          text: { type: 'plain_text', text: 'Suspend user' },
          style: 'danger',
          value: o.userId,
          confirm: confirmDialog('Suspend this user?', 'The bot ignores them everywhere until you unsuspend them (App Home).', 'Suspend'),
        },
        { type: 'button', action_id: 'mod:block_send', text: { type: 'plain_text', text: 'Block from send tool' }, value: o.userId },
        { type: 'button', action_id: 'mod:review_bot_report', text: { type: 'plain_text', text: 'Mark reviewed' }, value: String(o.reportId) },
        { type: 'button', action_id: 'mod:dismiss_bot_report', text: { type: 'plain_text', text: 'Dismiss' }, value: String(o.reportId) },
      ],
    },
  ];
}

const isUserId = (s: string | undefined): s is string => !!s && /^[UW][A-Z0-9]{2,}$/.test(s);

/** mod:suspend / mod:review_bot_report / mod:dismiss_bot_report — admin only. */
export async function handleBotReportModAction(ctx: ActionContext, refreshHome: (userId: string) => Promise<void>) {
  if (!(await requireAdmin(ctx))) return;
  const verb = ctx.actionId.slice('mod:'.length);

  if (verb === 'suspend') {
    const target = ctx.value;
    if (!isUserId(target)) return;
    if (isAdmin(target)) return modNote(ctx, "The admin can't be suspended.", refreshHome);
    await setBlock(target, { suspended: true, reason: `suspended by <@${ctx.userId}>` });
    await sql`
      update bot_reports set status = 'reviewed', reviewed_at = now(), reviewed_by = ${ctx.userId}
      where user_id = ${target} and status = 'pending'`;
    return modNote(ctx, `<@${target}> was suspended by <@${ctx.userId}>; their pending bot reports are marked reviewed.`, refreshHome);
  }

  if (verb === 'review_bot_report' || verb === 'dismiss_bot_report') {
    const id = Number(ctx.value);
    if (!Number.isSafeInteger(id)) return;
    const status = verb === 'review_bot_report' ? 'reviewed' : 'dismissed';
    const [row] = await sql`
      update bot_reports set status = ${status}, reviewed_at = now(), reviewed_by = ${ctx.userId}
      where id = ${id} and status = 'pending' returning id`;
    if (!row) return modNote(ctx, 'This bot report was already handled.', refreshHome);
    return modNote(ctx, `Bot report #${id} ${status} by <@${ctx.userId}>.`, refreshHome);
  }
}

export async function pendingBotReportsCount(): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from bot_reports where status = 'pending'`;
  return r?.n ?? 0;
}

export function registerReportUserTool() {
  registerTool({ name: 'report_user', roles: ['front'], build: reportUserTool });
}
