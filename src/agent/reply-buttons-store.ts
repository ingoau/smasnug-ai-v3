/** Persistence for quick-reply buttons (table reply_buttons, migrations 090, 330 and 345). */
import { sql } from '../db/index.js';
import { buttonPlace, parseButtonOutcome, parseButtonResponse, type ButtonOutcome, type ButtonResponse, type ButtonsState } from './reply-buttons.js';

export interface ReplyButtonsRow {
  id: number;
  threadId: string;
  channelId: string;
  turnId: number | null;
  messageTs: string | null;
  /** Markdown of the message carrying the buttons; null = a buttons-only message. */
  replyText: string | null;
  labels: string[];
  /** Per button: what a press does instead of a turn (null = a turn). Null for rows from before migration 330. */
  responses: (ButtonResponse | null)[] | null;
  pressedBy: string | null;
  pressedLabel: string | null;
  pressedMessageTs: string | null;
  pressedAt: Date | null;
  /** Who the reply answered (`who: requester` buttons only work for them). Null on older rows. */
  requesterId: string | null;
  /** What an action button's press did. */
  outcome: ButtonOutcome | null;
}

const norm = (r: any): ReplyButtonsRow => ({
  ...r,
  id: Number(r.id),
  turnId: r.turnId == null ? null : Number(r.turnId),
  labels: Array.isArray(r.labels) ? r.labels : [],
  responses: Array.isArray(r.responses) ? r.responses.map(parseButtonResponse) : null,
  requesterId: r.requesterId ?? null,
  outcome: parseButtonOutcome(r.outcome),
});

export const toButtonsState = (r: ReplyButtonsRow): ButtonsState => ({ id: r.id, labels: r.labels, pressedBy: r.pressedBy, pressedLabel: r.pressedLabel, responses: r.responses, outcome: r.outcome });

/** Create (or, for a retried turn, reuse) the row for one reply's buttons. Its id goes into the button values. */
export async function createReplyButtons(o: { threadId: string; channelId: string; turnId: number; key: string; labels: string[]; responses?: (ButtonResponse | null)[]; requesterId?: string | null }): Promise<ReplyButtonsRow> {
  // Only rows with a non-plain button store responses (single-word keys: the camelCase transform leaves them alone).
  const responses = o.responses?.some(Boolean) ? sql.json(o.responses as never) : null;
  const [row] = await sql`
    insert into reply_buttons (thread_id, channel_id, turn_id, idempotency_key, labels, responses, requester_id)
    values (${o.threadId}, ${o.channelId}, ${o.turnId}, ${o.key}, ${sql.json(o.labels)}, ${responses}, ${o.requesterId ?? null})
    on conflict (idempotency_key) do update set
      labels = case when reply_buttons.pressed_at is null then excluded.labels else reply_buttons.labels end,
      responses = case when reply_buttons.pressed_at is null then excluded.responses else reply_buttons.responses end
    returning *`;
  return norm(row);
}

/** Record which message carries the buttons (and its text, for re-renders). */
export async function setButtonsMessage(id: number, messageTs: string, replyText: string | null): Promise<void> {
  await sql`update reply_buttons set message_ts = ${messageTs}, reply_text = ${replyText} where id = ${id}`;
}

export async function loadReplyButtons(id: number): Promise<ReplyButtonsRow | undefined> {
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const [row] = await sql`select * from reply_buttons where id = ${id}`;
  return row ? norm(row) : undefined;
}

/** The buttons living in a given message (latest row if several). */
export async function buttonsForMessage(channelId: string, messageTs: string | null | undefined): Promise<ReplyButtonsRow | undefined> {
  if (!messageTs) return undefined;
  const [row] = await sql`select * from reply_buttons where channel_id = ${channelId} and message_ts = ${messageTs} order by id desc limit 1`;
  return row ? norm(row) : undefined;
}

/**
 * Atomically claim the first press of button `index`: only one press per row ever wins. Returns the claimed row
 * (pressed_label = labels[index]), or undefined when already pressed / unknown / not delivered.
 */
export async function claimPress(o: { id: number; index: number; userId: string; pressedMessageTs: string }): Promise<ReplyButtonsRow | undefined> {
  const [row] = await sql`
    update reply_buttons set pressed_by = ${o.userId}, pressed_label = labels->>${o.index}::int,
      pressed_message_ts = ${o.pressedMessageTs}, pressed_at = now()
    where id = ${o.id} and pressed_at is null and message_ts is not null
      and ${o.index}::int >= 0 and ${o.index}::int < jsonb_array_length(labels)
    returning *`;
  return row ? norm(row) : undefined;
}

export async function setPressedMessageTs(id: number, ts: string): Promise<void> {
  await sql`update reply_buttons set pressed_message_ts = ${ts} where id = ${id}`;
}

/** Record an action button's outcome, once (false when one is already recorded). */
export async function setButtonOutcome(id: number, outcome: ButtonOutcome): Promise<ReplyButtonsRow | undefined> {
  const [row] = await sql`update reply_buttons set outcome = ${sql.json(outcome as never)} where id = ${id} and outcome is null returning *`;
  return row ? norm(row) : undefined;
}

/**
 * Set the text of the reply carrying these buttons (a button response placed into it): stored on the row and on a plan
 * card living in that message, so every later re-render shows it. The caller re-renders.
 */
export async function replaceReplyText(row: ReplyButtonsRow, text: string): Promise<ReplyButtonsRow> {
  const [updated] = await sql`update reply_buttons set reply_text = ${text} where id = ${row.id} returning *`;
  if (row.messageTs) await sql`update cards set reply_text = ${text} where channel_id = ${row.channelId} and message_ts = ${row.messageTs} and reply_text is not null`;
  return updated ? norm(updated) : { ...row, replyText: text };
}

/** Where a turn's first reply goes when a prompt button with `place` append / replace started it. */
export interface PlaceTarget {
  ts: string;
  buttonsId: number;
  place: 'append' | 'replace';
}

/**
 * The message a user turn's first reply goes into: a prompt button with `place` append / replace pressed by one of the
 * turn's messages (the press is stored as a message with the press's ts). Null when there is none.
 */
export async function placeTargetFor(threadId: string, messageTs: readonly string[]): Promise<PlaceTarget | null> {
  if (!messageTs.length) return null;
  const rows = await sql`
    select * from reply_buttons where thread_id = ${threadId} and pressed_message_ts in ${sql(messageTs as string[])} and message_ts is not null
    order by pressed_at desc`;
  for (const raw of rows) {
    const row = norm(raw);
    const i = row.pressedLabel == null ? -1 : row.labels.indexOf(row.pressedLabel);
    const r = i >= 0 ? row.responses?.[i] : null;
    const place = buttonPlace(r);
    if (r?.kind === 'prompt' && place !== 'new' && row.messageTs) return { ts: row.messageTs, buttonsId: row.id, place };
  }
  return null;
}

/** True when a plan card in this message still has runs going (it must keep re-rendering there). */
export async function messageHasLiveCard(channelId: string, messageTs: string): Promise<boolean> {
  const [row] = await sql<{ live: boolean }[]>`
    select exists (select 1 from cards c join runs r on r.card_id = c.id
                   where c.channel_id = ${channelId} and c.message_ts = ${messageTs} and r.status in ('queued', 'running')) as live`;
  return Boolean(row?.live);
}

/** Plan cards living in a message lose it (a reply placed into that message brings its own card, or none). */
export async function detachMessageCards(channelId: string, messageTs: string): Promise<void> {
  await sql`update cards set message_ts = null where channel_id = ${channelId} and message_ts = ${messageTs}`;
}
