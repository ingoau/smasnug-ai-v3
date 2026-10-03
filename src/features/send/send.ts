/**
 * send_message: post in the current thread as the bot, or anywhere else on behalf of the speaker after a
 * code-enforced ephemeral confirmation (Send / Cancel). Sends outside the thread are attributed (custom username +
 * avatar + context line) and carry a Report button.
 */
import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { env, limits } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { appendEvent } from '../../core/events.js';
import { slackCall, slackErrorCode } from '../../core/slack.js';
import { registerTool, type ToolContext } from '../../core/tools.js';
import { redis } from '../../core/redis.js';
import { uploadFiles } from '../../agent/files.js';
import { replyBlocks } from '../../agent/slack-markdown.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { peekLimit, takeLimit } from '../guard.js';
import { getState } from '../state.js';
import { ephemeral, truncate, userProfile } from '../util.js';
import { CLICK_REPLIES, decideClick, isUuid, parseDestination, sanitizeOutgoing, type PendingSendRow } from './logic.js';

export const SEND_TEXT_MAX = 6000;

class UserFacingError extends Error {}

const FileSchema = z.object({ filename: z.string().min(1).max(200), content: z.string().max(200_000) });

export function sendMessageTool(ctx: ToolContext) {
  return tool({
    description:
      'Send a message. destination: "thread" posts in the current thread as you (the bot). Anything else — a channel ' +
      '("#name", "<#C…>", channel id) or a person ("<@U…>", user id, for a DM) — is sent on behalf of the current speaker, ' +
      'attributed to them, and only after they confirm a preview with a Send button. You will get "awaiting confirmation": ' +
      "don't claim it was sent. Markdown is supported. Write the text exactly as it should appear.",
    inputSchema: z.object({
      destination: z.string().describe('"thread", "#channel-name", "<#C…>", "<@U…>" or an id'),
      text: z.string().min(1).max(SEND_TEXT_MAX),
      files: z.array(FileSchema).max(5).optional().describe('Text files to attach'),
    }),
    execute: async ({ destination, text, files }) => {
      try {
        return await prepareSend(ctx, destination, text, files ?? []);
      } catch (err) {
        if (err instanceof UserFacingError) return err.message;
        log.error({ err }, 'send_message failed');
        return `send_message failed (${slackErrorCode(err) ?? 'error'}). Tell the user it didn't work.`;
      }
    },
  });
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function prepareSend(ctx: ToolContext, destination: string, rawText: string, files: { filename: string; content: string }[]) {
  const dest = parseDestination(destination, ctx.channelId);
  if (dest.kind === 'invalid') return dest.error;
  const text = sanitizeOutgoing(rawText);

  if (dest.kind === 'thread') {
    const key = `${ctx.turnId ?? ctx.threadId}:${hash(text + JSON.stringify(files))}`;
    await slackCall(
      'chat.postMessage',
      { channel: ctx.channelId, thread_ts: ctx.threadTs, text: truncate(text, 3000), blocks: replyBlocks(text) },
      { idempotencyKey: `send-thread:${key}` },
    );
    if (files.length) await uploadFiles({ channelId: ctx.channelId, threadTs: ctx.threadTs, files, idempotencyKey: `send-thread-files:${key}` });
    await appendEvent(ctx.threadId, 'send', 'bot', { destination: 'thread', text }).catch(() => {});
    return 'Posted in the thread.';
  }

  // Resolve and check the destination before asking for confirmation.
  let destId: string;
  let label: string;
  if (dest.kind === 'user') {
    const u = await slackCall<any>('users.info', { user: dest.id }).catch(() => undefined);
    if (!u?.user || u.user.deleted) return `There's no active user ${dest.id}.`;
    destId = dest.id;
    label = `a DM to <@${dest.id}>`;
  } else {
    const id = dest.kind === 'channel' ? dest.id : await resolveChannelName(dest.name);
    if (!id) return `I can't find a channel named #${(dest as { name: string }).name} (or I'm not allowed to see it).`;
    await checkChannel(id, ctx.speakerId);
    destId = id;
    label = `<#${id}>`;
  }

  const limitErr = await peekLimit('send', ctx.speakerId);
  if (limitErr) return limitErr;

  // Same request repeated within a turn → reuse the pending send.
  const [existing] = await sql<{ id: string }[]>`
    select id from pending_sends
    where requester_id = ${ctx.speakerId} and destination = ${destId} and text = ${text}
      and status = 'pending' and expires_at > now()`;
  if (existing) return 'Awaiting confirmation: the speaker already has this preview with Send / Cancel buttons.';

  const expiresAt = new Date(Date.now() + limits.pendingSendTtlMs);
  const [pending] = await sql<PendingSendRow[]>`
    insert into pending_sends (requester_id, thread_id, destination, text, files, expires_at)
    values (${ctx.speakerId}, (select id from threads where id = ${ctx.threadId}), ${destId}, ${text},
            ${sql.json(files as any)}, ${expiresAt})
    returning *`;

  const profile = await userProfile(ctx.speakerId);
  await slackCall(
    'chat.postEphemeral',
    {
      channel: ctx.channelId,
      user: ctx.speakerId,
      thread_ts: ctx.threadTs,
      text: `Send this on your behalf to ${label}?`,
      blocks: previewBlocks({ pendingId: pending!.id, label, text, files, profile, requesterId: ctx.speakerId }),
    },
    { idempotencyKey: `send-preview:${pending!.id}` },
  );
  await appendEvent(ctx.threadId, 'send_pending', ctx.speakerId, { pendingId: pending!.id, destination: destId }).catch(() => {});
  return `Awaiting confirmation: the speaker sees a private preview for ${label} with Send / Cancel buttons (expires in ${Math.round(
    limits.pendingSendTtlMs / 60_000,
  )} min). Nothing is sent until they click Send.`;
}

export function attributionName(requesterName: string) {
  // Slack truncates usernames at 80 chars.
  return truncate(`${env.BOT_DISPLAY_NAME} on behalf of ${requesterName}`, 80);
}

export function previewBlocks(o: {
  pendingId: string;
  label: string;
  text: string;
  files: { filename: string }[];
  profile: { name: string; avatar?: string };
  requesterId: string;
}): unknown[] {
  const header: any[] = [];
  if (o.profile.avatar) header.push({ type: 'image', image_url: o.profile.avatar, alt_text: o.profile.name });
  header.push({ type: 'mrkdwn', text: `*${attributionName(o.profile.name)}*` });
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Send this on your behalf to ${o.label}?* Only you can see this preview.` } },
    { type: 'divider' },
    { type: 'context', elements: header },
    // The message as it will be sent (code blocks as rich_text so Slack's markdown converter can't alter them).
    ...replyBlocks(o.text, { maxBlocks: 50 - 8 }),
  ];
  if (o.files.length)
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Attachments: ${o.files.map((f) => f.filename).join(', ')}` }] });
  blocks.push(
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Sent by <@${o.requesterId}> via ${env.BOT_DISPLAY_NAME}` }] },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'send:confirm', text: { type: 'plain_text', text: 'Send' }, style: 'primary', value: o.pendingId },
        { type: 'button', action_id: 'send:cancel', text: { type: 'plain_text', text: 'Cancel' }, value: o.pendingId },
      ],
    },
  );
  return blocks;
}

export function sentMessageBlocks(o: { text: string; requesterId: string; sentId: number }): unknown[] {
  return [
    ...replyBlocks(o.text, { maxBlocks: 50 - 2 }),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Sent by <@${o.requesterId}> via ${env.BOT_DISPLAY_NAME}` }] },
    {
      type: 'actions',
      elements: [{ type: 'button', action_id: 'report:open', text: { type: 'plain_text', text: 'Report' }, value: String(o.sentId) }],
    },
  ];
}

async function resolveChannelName(name: string): Promise<string | undefined> {
  const cacheKey = `features:chan:${name}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return cached;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await slackCall<any>('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of res.channels ?? []) {
      if (c?.name && c?.id) await redis.set(`features:chan:${String(c.name).toLowerCase()}`, c.id, 'EX', 600).catch(() => {});
    }
    const hit = (res.channels ?? []).find((c: any) => String(c.name).toLowerCase() === name);
    if (hit) return hit.id;
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return undefined;
}

/** Refuse archived channels, private channels the bot isn't in, and private channels the requester isn't in. */
async function checkChannel(channelId: string, requesterId: string) {
  let info: any;
  try {
    info = (await slackCall<any>('conversations.info', { channel: channelId })).channel;
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === 'channel_not_found') throw new UserFacingError("I can't see that channel. If it's private, someone has to invite me first.");
    throw err;
  }
  if (!info) throw new UserFacingError("I can't see that channel.");
  if (info.is_archived) throw new UserFacingError('That channel is archived.');
  if (info.is_im || info.is_mpim) {
    if (channelId.startsWith('D')) return; // only the current DM gets here (parseDestination)
    throw new UserFacingError('To message people directly, use their user id or mention.');
  }
  if (info.is_private) {
    if (!info.is_member) throw new UserFacingError("I'm not in that private channel. Someone has to invite me first.");
    if (!(await isMember(channelId, requesterId))) throw new UserFacingError("You're not a member of that private channel, so I can't post there for you.");
  }
}

async function isMember(channelId: string, userId: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await slackCall<any>('conversations.members', { channel: channelId, limit: 1000, ...(cursor ? { cursor } : {}) });
    if ((res.members ?? []).includes(userId)) return true;
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) return false;
  }
  return false;
}

// ---------- Send / Cancel clicks ----------

async function loadPending(id: string | undefined): Promise<PendingSendRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await sql<PendingSendRow[]>`select * from pending_sends where id = ${id}`;
  return row;
}

async function replyDecision(ctx: ActionContext, decision: Exclude<ReturnType<typeof decideClick>, 'ok'>) {
  const r = CLICK_REPLIES[decision];
  await ephemeral(ctx, r.text, { replace: r.replace });
}

export async function handleSendCancel(ctx: ActionContext) {
  const p = await loadPending(ctx.value);
  const decision = decideClick(p, ctx.userId);
  if (decision !== 'ok') return replyDecision(ctx, decision);
  await sql`update pending_sends set status = 'cancelled' where id = ${p!.id} and status = 'pending'`;
  await ephemeral(ctx, 'Cancelled.', { replace: true });
}

export async function handleSendConfirm(ctx: ActionContext) {
  const p = await loadPending(ctx.value);
  const decision = decideClick(p, ctx.userId);
  if (decision !== 'ok') return replyDecision(ctx, decision);

  // Claim atomically: a double click or a second worker can't send twice.
  const [claimed] = await sql<PendingSendRow[]>`
    update pending_sends set status = 'sending'
    where id = ${p!.id} and status = 'pending' and expires_at > now() returning *`;
  if (!claimed) {
    const again = decideClick(await loadPending(p!.id), ctx.userId);
    return replyDecision(ctx, again === 'ok' ? 'expired' : again);
  }

  const block = (await getState()).blocks.get(claimed.requesterId);
  if (block?.suspended || block?.sendBlocked) {
    await sql`update pending_sends set status = 'cancelled' where id = ${claimed.id}`;
    return ephemeral(ctx, "You're blocked from sending messages through the bot.", { replace: true });
  }
  const limitErr = await takeLimit('send', claimed.requesterId, claimed.threadId ?? undefined);
  if (limitErr) {
    await sql`update pending_sends set status = 'cancelled' where id = ${claimed.id}`;
    return ephemeral(ctx, `Not sent: you've reached the limit of ${limits.userSendsPerHour} messages per hour. Try again later.`, {
      replace: true,
    });
  }

  try {
    const sent = await deliver(claimed);
    await sql`update pending_sends set status = 'sent' where id = ${claimed.id}`;
    const link = sent.permalink ? ` <${sent.permalink}|View message>` : '';
    const fileNote = sent.filesFailed ? ' (attachments failed to upload)' : '';
    await ephemeral(ctx, `Sent ✓${link}${fileNote}`, { replace: true });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await sql`update pending_sends set status = 'cancelled' where id = ${claimed.id}`;
      return ephemeral(ctx, `Not sent: ${err.message}`, { replace: true });
    }
    // Unknown failure: allow another click while the preview is still valid.
    await sql`update pending_sends set status = 'pending' where id = ${claimed.id} and status = 'sending'`;
    log.error({ err, pendingId: claimed.id }, 'on-behalf send failed');
    await ephemeral(ctx, `Something broke while sending (${slackErrorCode(err) ?? 'error'}). Try clicking Send again.`);
  }
}

/** Post the attributed message, upload files, record it. */
export async function deliver(p: PendingSendRow): Promise<{ channel: string; ts: string; permalink?: string; sentId: number; filesFailed: boolean }> {
  let channel = p.destination;
  if (/^[UW]/.test(channel)) {
    const res = await slackCall<any>('conversations.open', { users: channel });
    channel = res.channel?.id;
    if (!channel) throw new UserFacingError("I couldn't open a DM with that person.");
  }
  const profile = await userProfile(p.requesterId);
  const [{ id: sentId } = { id: 0 }] = await sql<{ id: number }[]>`select nextval('sent_messages_id_seq')::int as id`;

  const args = {
    channel,
    text: truncate(`${p.text}\n— sent by ${profile.name} via ${env.BOT_DISPLAY_NAME}`, 3000),
    blocks: sentMessageBlocks({ text: p.text, requesterId: p.requesterId, sentId }),
    username: attributionName(profile.name),
    ...(profile.avatar ? { icon_url: profile.avatar } : {}),
    unfurl_links: false,
  };
  const posted = await postWithJoin(args, `send:${p.id}`);
  const ts: string = posted.ts;

  let filesFailed = false;
  if (p.files.length) {
    try {
      await uploadFiles({ channelId: channel, threadTs: ts, files: p.files, idempotencyKey: `send-files:${p.id}` });
    } catch (err) {
      filesFailed = true;
      log.error({ err, pendingId: p.id }, 'send attachment upload failed');
    }
  }

  const permalink: string | undefined = await slackCall<any>('chat.getPermalink', { channel, message_ts: ts })
    .then((r) => r.permalink)
    .catch(() => undefined);

  await sql`
    insert into sent_messages (id, channel_id, ts, requester_id, text, permalink, destination, pending_send_id)
    values (${sentId}, ${channel}, ${ts}, ${p.requesterId}, ${p.text}, ${permalink ?? null}, ${p.destination}, ${p.id})
    on conflict (channel_id, ts) do nothing`;

  if (p.threadId) {
    await appendEvent(p.threadId, 'send', p.requesterId, {
      destination: p.destination,
      channel,
      ts,
      permalink,
      text: p.text,
      sentMessageId: sentId,
    }).catch((err) => log.warn({ err }, 'send event append failed'));
  }
  return { channel, ts, permalink, sentId, filesFailed };
}

async function postWithJoin(args: Record<string, unknown>, idempotencyKey: string): Promise<any> {
  try {
    return await slackCall<any>('chat.postMessage', args, { idempotencyKey });
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === 'not_in_channel') {
      const info = await slackCall<any>('conversations.info', { channel: args.channel }).catch(() => undefined);
      if (info?.channel && !info.channel.is_private) {
        await slackCall('conversations.join', { channel: args.channel });
        return slackCall<any>('chat.postMessage', args, { idempotencyKey });
      }
      throw new UserFacingError("I'm not in that channel. Invite me first, then ask again.");
    }
    if (code === 'channel_not_found') throw new UserFacingError("I can't see that channel. Invite me first, then ask again.");
    if (code === 'is_archived') throw new UserFacingError('That channel is archived.');
    if (code === 'restricted_action' || code === 'restricted_action_read_only_channel' || code === 'ekm_access_denied')
      throw new UserFacingError("I'm not allowed to post in that channel.");
    if (code === 'cannot_dm_bot') throw new UserFacingError("I can't DM a bot.");
    throw err;
  }
}

/** Mark expired pending sends (stale clicks are refused either way; this keeps the table tidy). */
export async function expirePendingSends() {
  await sql`update pending_sends set status = 'expired' where status = 'pending' and expires_at <= now()`;
  // Clicks that crashed mid-send stay 'sending'; release them after the TTL so the state is honest.
  await sql`update pending_sends set status = 'expired' where status = 'sending' and expires_at <= now() - interval '10 minutes'`;
}

export function registerSendTool() {
  registerTool({ name: 'send_message', roles: ['front'], build: sendMessageTool });
}

