/**
 * Quick-reply button press (`reply:choice:<i>`, value = reply_buttons id): act as if the presser had replied with the
 * button's label in that thread.
 *
 * 1. Entry guard (counted like a message; channel disable applies). Blocked users get nothing, rate-limited ones an
 *    ephemeral notice, and the buttons stay for others.
 * 2. Claim the first press atomically; later / double presses get an ephemeral "already answered".
 * 3. Replace the buttons with "<@presser> pressed *label*" (chat.update from DB state; through the plan card when one
 *    lives in that message).
 * 4. Store a synthetic message (user = presser, text = label, ts derived from the action's action_ts), append a
 *    `message` event, mark the thread addressed + engaged, and schedule a mention turn for the presser (inbox push
 *    into their running turn, or a new / extended pending turn) — the same scheduling a debounced DM/mention gets.
 */
import type { ActionContext } from '../core/actions.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { rerenderButtonsMessage } from '../agent/cards.js';
import { claimPress, loadReplyButtons, setPressedMessageTs } from '../agent/reply-buttons-store.js';
import { REPLY_CHOICE_ACTION } from '../agent/reply-buttons.js';
import { guardEntry } from './entry.js';
import { neutralizeBroadcasts } from './guidelines.js';
import { RATE_LIMITED_TEXT } from './intake.js';
import { scheduleMessages } from './scheduler.js';

export const ALREADY_ANSWERED_TEXT = 'Someone already answered that one.';

const TS_RE = /^\d{9,11}\.\d{6}$/;

/** A Slack-style ts for the synthetic message: the action's `action_ts` (when the press happened), else now. */
export function pressTs(ctx: Pick<ActionContext, 'body' | 'actionId'>, now = Date.now()): string {
  const action = (ctx.body?.actions ?? []).find((a: any) => a?.action_id === ctx.actionId) ?? ctx.body?.actions?.[0];
  const raw = String(action?.action_ts ?? '');
  if (TS_RE.test(raw)) return raw;
  const us = Math.floor(now * 1000);
  return `${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, '0')}`;
}

/** Next microsecond (for a ts collision with a real message). */
function bumpTs(ts: string): string {
  const [s, u] = ts.split('.') as [string, string];
  const n = Number(u) + 1;
  return n >= 1e6 ? `${Number(s) + 1}.000000` : `${s}.${String(n).padStart(6, '0')}`;
}

async function ephemeral(ctx: ActionContext, channelId: string, threadTs: string, text: string) {
  const at = pressTs(ctx);
  await slackCall('chat.postEphemeral', { channel: channelId, user: ctx.userId, thread_ts: threadTs, text }, { idempotencyKey: `reply-choice:${channelId}:${ctx.userId}:${at}` }).catch((err) =>
    log.warn({ err }, 'reply-choice ephemeral failed'),
  );
}

/** Insert the press as a message; never overwrites a real message (bumps the ts on the off-chance of a clash). */
async function storePressMessage(channelId: string, threadId: string, userId: string, ts: string, text: string): Promise<string> {
  let t = ts;
  for (let i = 0; i < 5; i++) {
    const rows = await sql`
      insert into messages (channel_id, ts, thread_id, user_id, text) values (${channelId}, ${t}, ${threadId}, ${userId}, ${text})
      on conflict (channel_id, ts) do nothing returning ts`;
    if (rows.length) return t;
    t = bumpTs(t);
  }
  throw new Error('could not store button press message');
}

export async function handleReplyChoice(ctx: ActionContext): Promise<void> {
  const index = Number(ctx.actionId.slice(REPLY_CHOICE_ACTION.length + 1));
  const id = Number(ctx.value);
  if (!Number.isInteger(index) || index < 0) return;
  const row = await loadReplyButtons(id);
  if (!row || !row.messageTs) return;
  if (ctx.channelId && ctx.channelId !== row.channelId) return;
  const { threadTs } = parseThreadId(row.threadId);
  if (row.pressedAt) {
    await ephemeral(ctx, row.channelId, threadTs, ALREADY_ANSWERED_TEXT);
    return;
  }

  // Effectively a message from the presser: counted, and subject to channel disable / suspension.
  const entry = await guardEntry(ctx.userId, row.channelId);
  if (!entry.ok) {
    if (entry.reason === 'rate_limited') await ephemeral(ctx, row.channelId, threadTs, RATE_LIMITED_TEXT);
    return;
  }

  const ts = pressTs(ctx);
  const claimed = await claimPress({ id, index, userId: ctx.userId, pressedMessageTs: ts });
  if (!claimed) {
    await ephemeral(ctx, row.channelId, threadTs, ALREADY_ANSWERED_TEXT);
    return;
  }
  const label = neutralizeBroadcasts(claimed.pressedLabel ?? '');

  await rerenderButtonsMessage(claimed).catch((err) => log.warn({ err, buttonsId: id }, 'replacing reply buttons with the pressed note failed'));

  const storedTs = await storePressMessage(row.channelId, row.threadId, ctx.userId, ts, label);
  if (storedTs !== ts) await setPressedMessageTs(id, storedTs);
  await appendEvent(row.threadId, 'message', ctx.userId, { ts: storedTs, button: { id, label, messageTs: row.messageTs } });
  await sql`update threads set engaged = true, last_addressed_at = now(), messages_since_addressed = 0, last_activity_at = now()
            where id = ${row.threadId}`;
  const res = await scheduleMessages(row.threadId, ctx.userId, [storedTs], true);
  if (res.kind === 'inbox') await appendEvent(row.threadId, 'inbox_push', ctx.userId, { turnId: res.turnId, messageTs: [storedTs] });
  log.info({ threadId: row.threadId, buttonsId: id, userId: ctx.userId, scheduled: res.kind }, 'reply button pressed');
}
