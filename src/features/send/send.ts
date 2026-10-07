/**
 * send_message: post in the current thread as the bot, or anywhere else on behalf of the speaker after a
 * code-enforced ephemeral confirmation (Send / Cancel). Sends outside the thread are attributed (custom username +
 * avatar + context line) and carry a Report button. Resolving the preview (Send, Cancel, a definitive failure or
 * expiry) starts an outcome turn so the agent can confirm or acknowledge it (src/features/outcome-turn.ts); a
 * successful Send deletes the preview instead of leaving a confirmation in it.
 */
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { tool } from 'ai';
import { z } from 'zod';
import { env, limits } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { appendEvent } from '../../core/events.js';
import { slackCall, slackErrorCode } from '../../core/slack.js';
import { registerTool, type ToolContext } from '../../core/tools.js';
import { redis } from '../../core/redis.js';
import { prepareOutgoingFiles, uploadFiles, type OutgoingFile } from '../../agent/files.js';
import { replyBlocks } from '../../agent/slack-markdown.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { peekLimit, takeLimit } from '../guard.js';
import { getState } from '../state.js';
import { deleteOriginal, ephemeral, respond, truncate, userProfile, withThread } from '../util.js';
import { settleWithOutcome, type OutcomeResult } from '../outcome-turn.js';
import {
  CLICK_REPLIES,
  decideClick,
  isUuid,
  parseDestination,
  renderSendOutcome,
  sanitizeOutgoing,
  sendOutcomeFallback,
  sendOutcomeIsMention,
  type PendingSendRow,
  type SendOutcome,
} from './logic.js';
import { resumeSuspendedSession } from '../../pipeline/agent-session.js';

export const SEND_TEXT_MAX = 6000;

class UserFacingError extends Error {}

/** File ids (this conversation's files, or the speaker's own), or an inline text file stored first. */
const FileSchema = z.union([
  z.string().describe('A file id, e.g. "file_k3x9q2mf7a"'),
  z.object({ filename: z.string().min(1).max(200), content: z.string().max(200_000) }),
]);

export function sendMessageTool(ctx: ToolContext) {
  return tool({
    description:
      'Send a message. destination: "thread" posts in the current thread as you (the bot). Anything else — a channel ' +
      '("#name", "<#C…>", channel id) or a person ("<@U…>", user id, for a DM) — is sent on behalf of the current speaker, ' +
      'attributed to them, and only after they confirm a preview with a Send button. You will get "awaiting confirmation": ' +
      "nothing is sent yet and they already see the preview, so in THIS turn don't claim it was sent and don't reply about " +
      'the preview (normally just end the turn). Later a separate outcome turn (<send_outcome>) tells you what happened: ' +
      'then confirm briefly with the link, or acknowledge. Markdown is supported. Write the text exactly as it should appear.',
    inputSchema: z.object({
      destination: z.string().describe('"thread", "#channel-name", "<#C…>", "<@U…>" or an id'),
      text: z.string().min(1).max(SEND_TEXT_MAX),
      files: z.array(FileSchema).max(5).optional().describe('Files to attach: file ids (file_…), or inline text files {filename, content}'),
    }),
    execute: async ({ destination, text, files }) => {
      try {
        const prepared = await prepareOutgoingFiles({ threadId: ctx.threadId, speakerId: ctx.speakerId, turnId: ctx.turnId }, files);
        if (prepared.errors.length) return `Not sent: ${prepared.errors.join(' ')}`;
        return await prepareSend(ctx, destination, text, prepared.files);
      } catch (err) {
        if (err instanceof UserFacingError) return err.message;
        log.error({ err }, 'send_message failed');
        return `send_message failed (${slackErrorCode(err) ?? 'error'}). Tell the user it didn't work.`;
      }
    },
  });
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function prepareSend(ctx: ToolContext, destination: string, rawText: string, files: OutgoingFile[]) {
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
  if (existing) return `Awaiting confirmation: the speaker already has this preview with Send / Cancel buttons. ${AWAIT_NOTE}`;

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
  )} min). Nothing is sent until they click Send. ${AWAIT_NOTE}`;
}

const AWAIT_NOTE =
  "In this turn: don't reply about the preview (they see it) and don't say it was sent; unless something else in their " +
  'message needs an answer, just end the turn. A separate outcome turn (<send_outcome>) comes later: when it arrives, ' +
  'confirm briefly with the link (or acknowledge a cancel / failure).';

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
  // A second click on a preview that is already gone (deleted after sending): nothing to replace, no new ephemeral.
  if (decision === 'already_sent') return void (await respond(ctx.responseUrl, { replace_original: true, text: r.text }));
  await ephemeral(ctx, r.text, { replace: r.replace });
}

/** Conditional status change of a pending send, for settleSend (true = this call changed it). */
const transitionTo = (id: string, from: 'pending' | 'sending', to: 'sent' | 'cancelled' | 'expired', when: 'live' | 'expired' | 'any' = 'any') =>
  async (tx: TransactionSql<{}>) => {
    const expiry = when === 'live' ? sql`and expires_at > now()` : when === 'expired' ? sql`and expires_at <= now()` : sql``;
    const rows = await tx`update pending_sends set status = ${to} where id = ${id} and status = ${from} ${expiry} returning id`;
    return rows.length > 0;
  };

/**
 * Resolve a pending send and start the agent's outcome turn with it (exactly once; src/features/outcome-turn.ts). A DM
 * session suspended for this confirmation resumes here, unless a mention outcome turn will set its status itself
 * (processing, then its final one).
 */
async function settleSend(
  p: PendingSendRow,
  outcome: SendOutcome,
  transition: (tx: TransactionSql<{}>) => Promise<boolean>,
  opts: { isMention?: boolean; skip?: string } = {},
): Promise<OutcomeResult> {
  const isMention = opts.isMention ?? sendOutcomeIsMention(outcome);
  const res = await settleWithOutcome({
    threadId: p.threadId,
    speakerId: p.requesterId,
    source: 'send',
    sourceRef: p.id,
    input: renderSendOutcome({ pendingId: p.id, requesterId: p.requesterId, destination: p.destination, text: p.text, outcome }),
    fallback: sendOutcomeFallback(outcome),
    isMention,
    ...(opts.skip ? { skip: opts.skip } : {}),
    transition,
  });
  if (res.settled && (res.turnId == null || !isMention)) await resumeSuspendedSession(p.threadId);
  return res;
}

export async function handleSendCancel(ctx: ActionContext) {
  const p = await loadPending(ctx.value);
  ctx = withThread(ctx, p?.threadId); // answers go to the thread the preview is in
  const decision = decideClick(p, ctx.userId);
  if (decision !== 'ok') return replyDecision(ctx, decision);
  const res = await settleSend(p!, { kind: 'not_sent', reason: 'cancelled' }, transitionTo(p!.id, 'pending', 'cancelled', 'live'));
  if (!res.settled) {
    const again = decideClick(await loadPending(p!.id), ctx.userId);
    return replyDecision(ctx, again === 'ok' ? 'expired' : again);
  }
  // Kept (not deleted): instant feedback for the click; the agent's outcome turn acknowledges it in the thread.
  await ephemeral(ctx, 'Cancelled.', { replace: true });
}

export async function handleSendConfirm(ctx: ActionContext) {
  const p = await loadPending(ctx.value);
  ctx = withThread(ctx, p?.threadId); // answers go to the thread the preview is in
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
  // Definitive "not sent": the preview is replaced with the reason, and the agent hears about it.
  const notSent = async (reason: 'rate_limited' | 'failed', text: string, detail?: string, skip?: string) => {
    await settleSend(claimed, { kind: 'not_sent', reason, ...(detail ? { detail } : {}) }, transitionTo(claimed.id, 'sending', 'cancelled'), skip ? { skip } : {});
    await ephemeral(ctx, text, { replace: true });
  };

  // A block is told privately only: no outcome turn (the agent would announce it in a possibly public thread).
  const block = (await getState()).blocks.get(claimed.requesterId);
  if (block?.suspended || block?.sendBlocked) return notSent('failed', "You're blocked from sending messages through the bot.", undefined, 'send_blocked');
  const limitErr = await takeLimit('send', claimed.requesterId, claimed.threadId ?? undefined);
  if (limitErr) return notSent('rate_limited', `Not sent: you've reached the limit of ${limits.userSendsPerHour} messages per hour. Try again later.`);

  let sent: Awaited<ReturnType<typeof deliver>>;
  try {
    sent = await deliver(claimed);
  } catch (err) {
    if (err instanceof UserFacingError) return notSent('failed', `Not sent: ${err.message}`, err.message);
    // Unknown failure: allow another click while the preview is still valid (no outcome yet).
    await sql`update pending_sends set status = 'pending' where id = ${claimed.id} and status = 'sending'`;
    log.error({ err, pendingId: claimed.id }, 'on-behalf send failed');
    await ephemeral(ctx, `Something broke while sending (${slackErrorCode(err) ?? 'error'}). Try clicking Send again.`);
    return;
  }
  // Sent: the agent confirms it in the thread (outcome turn, with a code-written "sent ✓ <link>" if the model fails or
  // stays silent), so the preview just goes away. If no turn will run (paused, thread gone, a DB error), confirm in
  // the preview instead.
  const res = await settleSend(claimed, { kind: 'sent', permalink: sent.permalink, filesFailed: sent.filesFailed }, transitionTo(claimed.id, 'sending', 'sent')).catch(
    (err) => (log.error({ err, pendingId: claimed.id }, 'settling a sent message failed'), null),
  );
  if (res?.turnId != null && (await deleteOriginal(ctx))) return;
  if (!res) {
    // The row may still say 'sending': the stuck-send sweep must not start a late outcome turn for a send the user
    // sees confirmed here.
    await redis.set(confirmedKey(claimed.id), '1', 'EX', 2 * 24 * 3600).catch(() => {});
    await sql`update pending_sends set status = 'sent' where id = ${claimed.id} and status = 'sending'`.catch(() => {});
  }
  const link = sent.permalink ? ` <${sent.permalink}|View message>` : '';
  const fileNote = sent.filesFailed ? ' (attachments failed to upload)' : '';
  await ephemeral(ctx, `Sent ✓${link}${fileNote}`, { replace: true });
}

/** A send whose click path showed the user "Sent ✓" itself (its outcome couldn't be recorded). */
const confirmedKey = (pendingId: string) => `send:confirmed:${pendingId}`;

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
  // Recorded right away (permalink added below): if anything after this crashes, the stuck-send sweep still knows
  // the message went out.
  await sql`
    insert into sent_messages (id, channel_id, ts, requester_id, text, permalink, destination, pending_send_id)
    values (${sentId}, ${channel}, ${ts}, ${p.requesterId}, ${p.text}, null, ${p.destination}, ${p.id})
    on conflict (channel_id, ts) do nothing`;

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

  if (permalink) await sql`update sent_messages set permalink = ${permalink} where channel_id = ${channel} and ts = ${ts}`;

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

/** Outcome turns only for previews that expired recently (a sweep after downtime doesn't dig up old ones). */
const OUTCOME_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The message a crashed click posted, if any: sent_messages (written right after chat.postMessage), else the stored
 * result of the post's idempotency key (`chat.postMessage:send:<id>`, src/core/slack.ts).
 */
async function postedMessage(pendingId: string): Promise<{ permalink?: string } | null> {
  const [sent] = await sql<{ permalink: string | null }[]>`select permalink from sent_messages where pending_send_id = ${pendingId} limit 1`;
  if (sent) return { permalink: sent.permalink ?? undefined };
  const [key] = await sql<{ result: any }[]>`
    select result from idempotency_keys where key = ${`chat.postMessage:send:${pendingId}`} and result is not null`;
  const channel = key?.result?.channel;
  const ts = key?.result?.ts;
  if (!channel || !ts) return null;
  const permalink: string | undefined = await slackCall<any>('chat.getPermalink', { channel, message_ts: ts })
    .then((r) => r.permalink)
    .catch(() => undefined);
  return { permalink };
}

/**
 * Expire unanswered previews (stale clicks are refused either way): each gets its outcome turn, so the agent knows
 * nothing was sent. Clicks that crashed mid-send stay 'sending'; after the TTL they are settled too: 'sent' when the
 * message did go out, otherwise expired with an "interrupted" outcome. Those are late, so non-mention turns, and none
 * at all when the click path already showed the user "Sent ✓".
 */
export async function expirePendingSends() {
  const ttlMin = Math.round(limits.pendingSendTtlMs / 60_000);
  const settle = async (
    p: PendingSendRow,
    outcome: SendOutcome,
    transition: (tx: TransactionSql<{}>) => Promise<boolean>,
    opts: { isMention?: boolean; skip?: string } = {},
  ) => {
    try {
      if (Date.now() - new Date(p.expiresAt).getTime() < OUTCOME_MAX_AGE_MS) await settleSend(p, outcome, transition, opts);
      else if (await sql.begin(transition)) await resumeSuspendedSession(p.threadId);
    } catch (err) {
      log.warn({ err, pendingId: p.id }, 'expiring a pending send failed');
    }
  };
  const due = await sql<PendingSendRow[]>`
    select * from pending_sends where status = 'pending' and expires_at <= now() order by expires_at limit 500`;
  for (const p of due) await settle(p, { kind: 'expired', ttlMin }, transitionTo(p.id, 'pending', 'expired', 'expired'));

  const stuck = await sql<PendingSendRow[]>`
    select * from pending_sends where status = 'sending' and expires_at <= now() - interval '10 minutes' order by expires_at limit 100`;
  for (const p of stuck) {
    try {
      const sent = await postedMessage(p.id);
      const confirmed = (await redis.exists(confirmedKey(p.id)).catch(() => 0)) > 0;
      const opts = { isMention: false, ...(confirmed ? { skip: 'confirmed_in_preview' } : {}) };
      if (sent) await settle(p, { kind: 'sent', ...(sent.permalink ? { permalink: sent.permalink } : {}) }, transitionTo(p.id, 'sending', 'sent'), opts);
      else await settle(p, { kind: 'not_sent', reason: 'failed', detail: 'the send was interrupted' }, transitionTo(p.id, 'sending', 'expired'), opts);
    } catch (err) {
      log.warn({ err, pendingId: p.id }, 'settling a stuck send failed');
    }
  }
}

export function registerSendTool() {
  registerTool({ name: 'send_message', roles: ['front'], build: sendMessageTool });
}

