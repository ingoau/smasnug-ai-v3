/** Reports on on-behalf sends, moderation actions, and auto-suspension. */
import { limits } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { getState, setBlock } from './state.js';
import { ephemeral, fromAppHome, isAdmin, postToModChannel, quote, requireAdmin } from './util.js';

interface SentRow {
  id: number;
  channelId: string;
  ts: string;
  requesterId: string;
  text: string;
  permalink: string | null;
  destination: string | null;
}

export interface ReportSnapshot {
  sentMessageId: number;
  text: string;
  currentText?: string;
  senderId: string;
  channelId: string;
  ts: string;
  destination: string | null;
  permalink: string | null;
  reportedAt: string;
}

/** Pure: should this sender be suspended now? */
export function shouldAutoSuspend(o: { distinctReporters: number; alreadySuspended: boolean; senderIsAdmin: boolean }) {
  return !o.alreadySuspended && !o.senderIsAdmin && o.distinctReporters >= limits.autoSuspendReporters;
}

/** Distinct reporters (excluding the sender) across the sender's unreviewed reports. */
export async function countDistinctReporters(senderId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(distinct r.reporter_id)::int as n
    from reports r join sent_messages s on s.id = r.sent_message_id
    where s.requester_id = ${senderId} and r.reporter_id <> ${senderId} and r.reviewed_at is null`;
  return r?.n ?? 0;
}

/** Store a report. Returns null if this reporter already reported this message. */
export async function recordReport(sent: SentRow, reporterId: string, currentText?: string) {
  const snapshot: ReportSnapshot = {
    sentMessageId: sent.id,
    text: sent.text,
    ...(currentText && currentText !== sent.text ? { currentText } : {}),
    senderId: sent.requesterId,
    channelId: sent.channelId,
    ts: sent.ts,
    destination: sent.destination,
    permalink: sent.permalink,
    reportedAt: new Date().toISOString(),
  };
  const [row] = await sql<{ id: number }[]>`
    insert into reports (sent_message_id, reporter_id, snapshot)
    values (${sent.id}, ${reporterId}, ${sql.json(snapshot as any)})
    on conflict (sent_message_id, reporter_id) do nothing returning id`;
  return row ? { reportId: row.id, snapshot } : null;
}

/** After a new report: suspend the sender if enough distinct people reported them. Returns true if suspended now. */
export async function maybeAutoSuspend(senderId: string): Promise<{ suspended: boolean; reporters: number }> {
  const reporters = await countDistinctReporters(senderId);
  const alreadySuspended = !!(await getState()).blocks.get(senderId)?.suspended;
  if (!shouldAutoSuspend({ distinctReporters: reporters, alreadySuspended, senderIsAdmin: isAdmin(senderId) }))
    return { suspended: false, reporters };
  await setBlock(senderId, { suspended: true, reason: `auto-suspended: reported by ${reporters} people` });
  return { suspended: true, reporters };
}

function destinationLabel(s: { destination: string | null; channelId: string }) {
  if (s.destination && /^[UW]/.test(s.destination)) return `a DM to <@${s.destination}>`;
  return `<#${s.channelId}>`;
}

function currentMessageText(ctx: ActionContext): string | undefined {
  const blocks: any[] = ctx.body?.message?.blocks ?? [];
  const md = blocks.find((b) => b?.type === 'markdown');
  return typeof md?.text === 'string' ? md.text : undefined;
}

/** report:open — value = sent_messages.id */
export async function handleReport(ctx: ActionContext) {
  const id = Number(ctx.value);
  const [sent] = Number.isSafeInteger(id) ? await sql<SentRow[]>`select * from sent_messages where id = ${id}` : [];
  if (!sent) return ephemeral(ctx, "This message can't be reported any more.");

  const rec = await recordReport(sent, ctx.userId, currentMessageText(ctx));
  if (!rec) return ephemeral(ctx, 'You already reported this message. Thanks.');

  const reporters = await countDistinctReporters(sent.requesterId);
  const s = rec.snapshot;
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Report* from <@${ctx.userId}> about a message sent on behalf of <@${s.senderId}> to ${destinationLabel(sent)}\n${quote(s.text)}`,
      },
    },
  ];
  if (s.currentText) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Currently shows:*\n${quote(s.currentText, 1500)}` } });
  blocks.push(
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${s.permalink ? `<${s.permalink}|Open message> · ` : ''}Distinct reporters for <@${s.senderId}>: ${reporters} (auto-suspend at ${limits.autoSuspendReporters})`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'mod:delete',
          text: { type: 'plain_text', text: 'Delete message' },
          style: 'danger',
          value: String(sent.id),
          confirm: confirmDialog('Delete this message?', 'It is removed from Slack for everyone. The report keeps a copy.', 'Delete'),
        },
        { type: 'button', action_id: 'mod:block_send', text: { type: 'plain_text', text: 'Block from send tool' }, value: s.senderId },
        { type: 'button', action_id: 'mod:dismiss', text: { type: 'plain_text', text: 'Mark reviewed' }, value: String(sent.id) },
      ],
    },
  );
  try {
    await postToModChannel(`Report about a message sent on behalf of <@${s.senderId}>`, blocks, `report:${rec.reportId}`);
  } catch (err) {
    log.error({ err, reportId: rec.reportId }, 'posting report to mod channel failed');
  }
  await ephemeral(ctx, 'Thanks, reported.');

  const res = await maybeAutoSuspend(s.senderId);
  if (res.suspended) {
    await postToModChannel(
      `<@${s.senderId}> was auto-suspended`,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*<@${s.senderId}> was auto-suspended* after reports from ${res.reporters} different people. The bot ignores them everywhere until you review.`,
          },
          accessory: { type: 'button', action_id: 'mod:unsuspend', text: { type: 'plain_text', text: 'Unsuspend' }, value: s.senderId },
        },
      ],
      `suspend:${s.senderId}:${rec.reportId}`,
    ).catch((err) => log.error({ err }, 'posting suspension notice failed'));
  }
}

export function confirmDialog(title: string, text: string, confirm: string) {
  return {
    title: { type: 'plain_text', text: title },
    text: { type: 'plain_text', text },
    confirm: { type: 'plain_text', text: confirm },
    deny: { type: 'plain_text', text: 'Cancel' },
    style: 'danger',
  };
}

/** Admin-facing confirmation of a moderation action: thread reply under the mod message, App Home refresh, or ephemeral. */
async function modNote(ctx: ActionContext, text: string, refreshHome: (userId: string) => Promise<void>) {
  if (fromAppHome(ctx)) return refreshHome(ctx.userId);
  if (ctx.channelId && ctx.messageTs) {
    await slackCall('chat.postMessage', { channel: ctx.channelId, thread_ts: ctx.messageTs, text }).catch(() => ephemeral(ctx, text));
  } else await ephemeral(ctx, text);
}

const isUserId = (s: string | undefined): s is string => !!s && /^[UW][A-Z0-9]{2,}$/.test(s);

export async function unsuspend(userId: string) {
  await setBlock(userId, { suspended: false });
  await sql`
    update reports set reviewed_at = now()
    where reviewed_at is null and sent_message_id in (select id from sent_messages where requester_id = ${userId})`;
}

/** mod:delete / mod:dismiss / mod:block_send / mod:unsuspend / mod:unblock_send — admin only. */
export async function handleModAction(ctx: ActionContext, refreshHome: (userId: string) => Promise<void>) {
  if (!(await requireAdmin(ctx))) return;
  const verb = ctx.actionId.slice('mod:'.length);

  if (verb === 'dismiss') {
    const id = Number(ctx.value);
    if (!Number.isSafeInteger(id)) return;
    await markReviewed(id);
    return modNote(ctx, `Reports on this message marked reviewed by <@${ctx.userId}>.`, refreshHome);
  }

  if (verb === 'delete') {
    const id = Number(ctx.value);
    const [sent] = Number.isSafeInteger(id) ? await sql<SentRow[]>`select * from sent_messages where id = ${id}` : [];
    if (!sent) return ephemeral(ctx, 'Unknown message.');
    try {
      await slackCall('chat.delete', { channel: sent.channelId, ts: sent.ts });
    } catch (err) {
      if (slackErrorCode(err) !== 'message_not_found') {
        log.error({ err }, 'mod delete failed');
        return ephemeral(ctx, `Delete failed: ${slackErrorCode(err) ?? 'error'}`);
      }
    }
    await markReviewed(sent.id);
    return modNote(ctx, `Message deleted by <@${ctx.userId}>; its reports are marked reviewed.`, refreshHome);
  }

  const target = ctx.value;
  if (!isUserId(target)) return;
  if (verb === 'block_send') {
    await setBlock(target, { sendBlocked: true, reason: `send-blocked by <@${ctx.userId}>` });
    return modNote(ctx, `<@${target}> is blocked from the send tool (by <@${ctx.userId}>).`, refreshHome);
  }
  if (verb === 'unblock_send') {
    await setBlock(target, { sendBlocked: false });
    return modNote(ctx, `<@${target}> can use the send tool again (by <@${ctx.userId}>).`, refreshHome);
  }
  if (verb === 'unsuspend') {
    await unsuspend(target);
    return modNote(ctx, `<@${target}> was unsuspended by <@${ctx.userId}>; their earlier reports are marked reviewed.`, refreshHome);
  }
}

async function markReviewed(sentMessageId: number) {
  await sql`update reports set reviewed_at = now() where sent_message_id = ${sentMessageId} and reviewed_at is null`;
}

export async function pendingReportsCount(): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from reports where reviewed_at is null`;
  return r?.n ?? 0;
}
