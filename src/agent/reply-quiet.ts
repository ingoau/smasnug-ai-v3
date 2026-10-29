/**
 * A no-turn quick-reply button press (`reply:quiet:<i>`, value = reply_buttons id; reply-buttons.ts): the reply marked
 * the button `no_turn` (optionally with a `fixed_reply`), e.g. "No thanks". Like a normal press (src/pipeline/
 * reply-choice.ts) minus the model turn:
 * 1. Entry guard (counted like a message; blocked users get nothing, rate-limited ones an ephemeral notice).
 * 2. Claim the first press atomically; later / double presses get an ephemeral "already answered".
 * 3. Replace the buttons with "<@presser> pressed *label*".
 * 4. Store the press as the presser's message (thread history for later turns) with a `message` event, but schedule
 *    nothing and leave the thread's addressed / engaged state alone.
 * 5. A fixed reply is posted by code (idempotency key per buttons row) and logged as a `reply` event.
 * No privacy prompt: no turn starts and their messages are stored anyway (CLAUDE.md privacy policy). A stored row
 * without a response for that button (older rows) falls through to the normal press handler.
 */
import type { ActionContext } from '../core/actions.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { guardEntry } from '../pipeline/entry.js';
import { RATE_LIMITED_TEXT } from '../pipeline/intake.js';
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { ALREADY_ANSWERED_TEXT, handleReplyChoice, pressTs } from '../pipeline/reply-choice.js';
import { noteBotReply } from '../pipeline/store.js';
import { rerenderButtonsMessage } from './cards.js';
import { markdownMessage } from './reply.js';
import { claimPress, loadReplyButtons, setPressedMessageTs } from './reply-buttons-store.js';
import { REPLY_CHOICE_ACTION, REPLY_QUIET_ACTION } from './reply-buttons.js';

async function ephemeral(ctx: ActionContext, channelId: string, threadTs: string, text: string) {
  await slackCall('chat.postEphemeral', { channel: channelId, user: ctx.userId, thread_ts: threadTs, text }, { idempotencyKey: `reply-quiet:${channelId}:${ctx.userId}:${pressTs(ctx)}` }).catch((err) =>
    log.warn({ err }, 'reply-quiet ephemeral failed'),
  );
}

/** The press as the presser's message; never overwrites a real one (bumps the ts by a microsecond on a clash). */
async function storePress(channelId: string, threadId: string, userId: string, ts: string, text: string): Promise<string> {
  let t = ts;
  for (let i = 0; i < 5; i++) {
    const rows = await sql`
      insert into messages (channel_id, ts, thread_id, user_id, text) values (${channelId}, ${t}, ${threadId}, ${userId}, ${text})
      on conflict (channel_id, ts) do nothing returning ts`;
    if (rows.length) return t;
    const [s, u] = t.split('.') as [string, string];
    const n = Number(u) + 1;
    t = n >= 1e6 ? `${Number(s) + 1}.000000` : `${s}.${String(n).padStart(6, '0')}`;
  }
  throw new Error('could not store button press message');
}

export async function handleQuietChoice(ctx: ActionContext): Promise<void> {
  const index = Number(ctx.actionId.slice(REPLY_QUIET_ACTION.length + 1));
  const id = Number(ctx.value);
  if (!Number.isInteger(index) || index < 0) return;
  const row = await loadReplyButtons(id);
  if (!row || !row.messageTs) return;
  if (ctx.channelId && ctx.channelId !== row.channelId) return;
  const response = row.responses?.[index];
  // No stored response for this button: a normal press (starts a turn).
  if (!response) return handleReplyChoice({ ...ctx, actionId: `${REPLY_CHOICE_ACTION}:${index}` });
  const { threadTs } = parseThreadId(row.threadId);
  if (row.pressedAt) return ephemeral(ctx, row.channelId, threadTs, ALREADY_ANSWERED_TEXT);

  const entry = await guardEntry(ctx.userId, row.channelId);
  if (!entry.ok) {
    if (entry.reason === 'rate_limited') await ephemeral(ctx, row.channelId, threadTs, RATE_LIMITED_TEXT);
    return;
  }

  const ts = pressTs(ctx);
  const claimed = await claimPress({ id, index, userId: ctx.userId, pressedMessageTs: ts });
  if (!claimed) return ephemeral(ctx, row.channelId, threadTs, ALREADY_ANSWERED_TEXT);
  const label = neutralizeBroadcasts(claimed.pressedLabel ?? '');

  await rerenderButtonsMessage(claimed).catch((err) => log.warn({ err, buttonsId: id }, 'replacing reply buttons with the pressed note failed'));

  const storedTs = await storePress(row.channelId, row.threadId, ctx.userId, ts, label);
  if (storedTs !== ts) await setPressedMessageTs(id, storedTs);
  await appendEvent(row.threadId, 'message', ctx.userId, { ts: storedTs, button: { id, label, messageTs: row.messageTs, noTurn: true } });

  if (response.kind === 'text') {
    const text = neutralizeBroadcasts(response.text);
    const res = await slackCall<any>('chat.postMessage', { channel: row.channelId, thread_ts: threadTs, ...markdownMessage(text) }, { idempotencyKey: `reply-quiet:${id}` });
    await noteBotReply(row.threadId, { ts: typeof res?.ts === 'string' ? res.ts : null, partnerId: ctx.userId, awaitsReply: false }).catch((err) => log.warn({ err }, 'noteBotReply failed'));
    await appendEvent(row.threadId, 'reply', 'bot', { turnId: row.turnId, buttonsId: id, fixedReply: true, text });
  }
  log.info({ threadId: row.threadId, buttonsId: id, userId: ctx.userId, response: response.kind }, 'no-turn reply button pressed');
}
