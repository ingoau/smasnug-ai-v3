/** Persistence for quick-reply buttons (table reply_buttons, migration 090). */
import { sql } from '../db/index.js';
import type { ButtonsState } from './reply-buttons.js';

export interface ReplyButtonsRow {
  id: number;
  threadId: string;
  channelId: string;
  turnId: number | null;
  messageTs: string | null;
  /** Markdown of the message carrying the buttons; null = a buttons-only message. */
  replyText: string | null;
  labels: string[];
  pressedBy: string | null;
  pressedLabel: string | null;
  pressedMessageTs: string | null;
  pressedAt: Date | null;
}

const norm = (r: any): ReplyButtonsRow => ({ ...r, id: Number(r.id), turnId: r.turnId == null ? null : Number(r.turnId), labels: Array.isArray(r.labels) ? r.labels : [] });

export const toButtonsState = (r: ReplyButtonsRow): ButtonsState => ({ id: r.id, labels: r.labels, pressedBy: r.pressedBy, pressedLabel: r.pressedLabel });

/** Create (or, for a retried turn, reuse) the row for one reply's buttons. Its id goes into the button values. */
export async function createReplyButtons(o: { threadId: string; channelId: string; turnId: number; key: string; labels: string[] }): Promise<ReplyButtonsRow> {
  const [row] = await sql`
    insert into reply_buttons (thread_id, channel_id, turn_id, idempotency_key, labels)
    values (${o.threadId}, ${o.channelId}, ${o.turnId}, ${o.key}, ${sql.json(o.labels)})
    on conflict (idempotency_key) do update set labels = case when reply_buttons.pressed_at is null then excluded.labels else reply_buttons.labels end
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
