/**
 * Ephemeral mode (`@bot !p …`, pipeline/guidelines.ts rule 5): a private turn's output goes only to its author.
 *
 * - Replies are posted whole with chat.postEphemeral (an ephemeral message can't be streamed or edited), in the thread
 *   when it has replies, else at the channel root next to the question (privateThreadTs).
 * - Each one carries a "Send to thread" button: it posts the same answer publicly in the thread (and removes the
 *   ephemeral). The answer is kept in `ephemeral_replies` for that (retention: a week).
 * - Files go to the author's DM; canvases are shared with the author only (tools/canvases.ts).
 * - Tools with a public effect are not offered (PRIVATE_HIDDEN_TOOLS); the turn's card never posts (cards.ts) and
 *   its subagents are private to the author (subagents.private_to), with a private results turn.
 */
import { parseThreadId, appendEvent, threadTsArg } from '../core/events.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import type { ActionContext } from '../core/actions.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { uploadFiles, type OutgoingFile } from './files.js';
import { replyLayout, markdownMessage } from './reply.js';
import type { ReplyExtras } from './rich-blocks.js';
import type { ButtonsActionsBlock, ContextBlock } from './reply-buttons.js';
import { deleteOriginal } from '../features/util.js';
import { noteBotReply } from '../pipeline/store.js';

export const PRIVATE_SHARE_ACTION = 'private:share';

/**
 * Front tools never offered in a private turn: each one has an effect others can see (a reaction, a post, a
 * reminder or watch that fires publicly later, a code channel, a DJ session, an emoji) or ends the thread for everyone.
 */
export const PRIVATE_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'react',
  'unreact',
  'leave_thread',
  'send_message',
  'spawn_coding_agent',
  'upload_emoji',
  'set_reminder',
  'create_watch',
  'huddle_dj_mode',
  'huddle_dj',
  'huddle_dj_settings',
  'open_code_channel',
  'set_view',
  'remove_view',
  'report_to_parent',
  'ask_code_channel',
  'message_code_channel',
  'archive_code_channel',
  // Posts to the moderators and, once approved, goes into every turn's prompt.
  'propose_workspace_fact',
]);

/** Front tools fine in a private turn: read-only, private to the speaker, or adapted (reply, canvases, files). */
export const PRIVATE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'end_turn',
  'reply',
  'spawn_subagent',
  'message_subagent',
  'cancel_subagent',
  'read_subagent_result',
  'load_skill',
  'search_past_conversations',
  'read_canvas',
  'create_canvas',
  'edit_canvas',
  'calculate',
  'read_public_channel',
  'fetch_url',
  'read_thread',
  'read_channel',
  'read_public_thread',
  'download_emoji',
  'ask_thread',
  'view_profile_picture',
  'slack_search',
  'search_emojis',
  'find_people',
  'find_channels',
  'web_search',
  'report_user',
  'list_reminders',
  'cancel_reminder',
  'list_watches',
  'cancel_watch',
  'remember',
  'forget',
  'search_memory',
  'report_failure',
  'read_file',
  'ask_file',
  'create_file',
  'save_url',
]);

/**
 * Where a private turn's ephemerals go: into the thread when it has replies (the question was asked in a thread),
 * else at the channel root, next to the top-level question (an ephemeral "in" a thread nobody opened is never seen).
 */
export async function privateThreadTs(threadId: string): Promise<string | undefined> {
  const { threadTs } = parseThreadId(threadId);
  const [row] = await sql<{ replies: boolean }[]>`
    select exists (select 1 from messages where thread_id = ${threadId} and ts <> ${threadTs} and not deleted) as replies`;
  return row?.replies ? threadTs : undefined;
}

/** A code-written private note (fallback, error, canvas link) to the turn's author. Never throws. */
export async function postPrivateNote(opts: { threadId: string; userId: string; text: string; idempotencyKey: string }): Promise<void> {
  const { channelId } = parseThreadId(opts.threadId);
  try {
    const threadTs = await privateThreadTs(opts.threadId);
    await slackCall('chat.postEphemeral', { channel: channelId, user: opts.userId, ...markdownMessage(opts.text), ...threadTsArg(threadTs) }, { idempotencyKey: opts.idempotencyKey });
  } catch (err) {
    log.warn({ err, code: slackErrorCode(err), threadId: opts.threadId }, 'private note failed');
  }
}

/** The "Send to thread" row under a private answer. */
export function shareActions(replyId: number): ButtonsActionsBlock {
  return {
    type: 'actions',
    elements: [{ type: 'button', action_id: PRIVATE_SHARE_ACTION, text: { type: 'plain_text', text: 'Send to thread' }, value: String(replyId) }],
  } as unknown as ButtonsActionsBlock;
}

/** Keep a private answer for its "Send to thread" button. */
export async function savePrivateReply(r: { threadId: string; userId: string; turnId: number; text: string; extras: ReplyExtras | null; files: OutgoingFile[] }): Promise<number> {
  const { channelId } = parseThreadId(r.threadId);
  const files = r.files.filter((f) => f.fileId).map((f) => ({ fileId: f.fileId, filename: f.filename }));
  const [row] = await sql<{ id: number }[]>`
    insert into ephemeral_replies (thread_id, channel_id, user_id, turn_id, text, extras, files)
    values (${r.threadId}, ${channelId}, ${r.userId}, ${r.turnId}, ${r.text}, ${r.extras ? sql.json(r.extras as never) : null}, ${sql.json(files as never)})
    returning id::int as id`;
  return row!.id;
}

/** Send a private answer's files to the author's DM (an ephemeral message can't carry files). */
export async function sendFilesToDm(userId: string, files: OutgoingFile[], idempotencyKey: string): Promise<void> {
  const open = await slackCall<any>('conversations.open', { users: userId });
  const dm = open?.channel?.id as string | undefined;
  if (!dm) throw new Error('conversations.open returned no channel');
  await uploadFiles({ channelId: dm, files, idempotencyKey });
}

/** A short ephemeral to the user where their private answers go (a button's own thread_ts may be missing). */
async function tellUser(userId: string, threadId: string, text: string): Promise<void> {
  const { channelId } = parseThreadId(threadId);
  await slackCall('chat.postEphemeral', { channel: channelId, user: userId, text, ...threadTsArg(await privateThreadTs(threadId)) }).catch((err) =>
    log.warn({ err, threadId }, 'private share note failed'),
  );
}

interface PrivateReplyRow {
  id: number;
  threadId: string;
  channelId: string;
  userId: string;
  text: string;
  extras: ReplyExtras | null;
  files: { fileId: string; filename: string }[];
  sharedTs: string | null;
}

/** "Send to thread": post the private answer publicly in its thread (once), then remove the ephemeral. */
export async function handlePrivateShare(ctx: ActionContext): Promise<void> {
  const id = Number(ctx.value);
  if (!Number.isFinite(id)) return;
  // Claimed atomically: a double click (or a retried interaction) posts once. A claim a crash left behind can be
  // retaken after a minute (the post's idempotency key keeps that from posting twice).
  const [row] = await sql<PrivateReplyRow[]>`
    update ephemeral_replies set shared_ts = 'pending', share_claimed_at = now()
    where id = ${id} and user_id = ${ctx.userId}
      and (shared_ts is null or (shared_ts = 'pending' and share_claimed_at < now() - interval '1 minute'))
    returning id::int as id, thread_id, channel_id, user_id, text, extras, files, shared_ts`;
  if (!row) {
    const [had] = await sql<{ sharedTs: string | null; threadId: string }[]>`select shared_ts, thread_id from ephemeral_replies where id = ${id} and user_id = ${ctx.userId}`;
    // Being sent by an earlier press: keep the button (that press may still fail and ask to try again).
    if (had?.sharedTs === 'pending') {
      await tellUser(ctx.userId, had.threadId, 'Already sending that to the thread…');
      return;
    }
    await deleteOriginal(ctx).catch(() => false);
    return;
  }
  const { channelId, threadTs } = parseThreadId(row.threadId);
  const note: ContextBlock = { type: 'context', elements: [{ type: 'mrkdwn', text: '_Shared from a private answer._' }] };
  let ts: string | null = null;
  try {
    const layout = replyLayout(row.text, note, null, row.extras);
    const send = (msg: { text: string; blocks?: unknown[] }) =>
      slackCall<any>('chat.postMessage', { channel: channelId, ...threadTsArg(threadTs), ...msg, unfurl_links: false }, { idempotencyKey: `private-share:${id}` });
    let res: any;
    try {
      res = await send(layout);
    } catch (err) {
      // Slack refused the extras' blocks: their text fallbacks instead.
      if (!/invalid_blocks/.test(slackErrorCode(err) ?? '')) throw err;
      res = await send(markdownMessage(layout.text));
    }
    ts = typeof res?.ts === 'string' ? res.ts : null;
    if (row.files.length) {
      await uploadFiles({ channelId, threadTs, files: row.files, idempotencyKey: `private-share-files:${id}` }).catch(async (err) => {
        log.warn({ err, id }, 'sharing a private answer: its files failed');
        await tellUser(ctx.userId, row.threadId, "The answer is in the thread, but its files couldn't be shared there (they're still in your DM).");
      });
    }
  } catch (err) {
    log.warn({ err, code: slackErrorCode(err), id }, 'sharing a private answer failed');
    await sql`update ephemeral_replies set shared_ts = null where id = ${id} and shared_ts = 'pending'`;
    await tellUser(ctx.userId, row.threadId, "Couldn't send that to the thread, try again.");
    return;
  }
  await sql`update ephemeral_replies set shared_ts = ${ts ?? 'shared'} where id = ${id}`;
  // A public bot reply from now on: the thread's idle clock and partner, as for any reply.
  await noteBotReply(row.threadId, { ts, partnerId: row.userId, awaitsReply: false }).catch((err) => log.warn({ err }, 'noteBotReply failed'));
  await appendEvent(row.threadId, 'private_reply_shared', ctx.userId, { replyId: id, ts }).catch(() => {});
  await deleteOriginal(ctx).catch(() => false);
}
