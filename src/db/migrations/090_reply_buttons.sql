-- Quick-reply buttons under a bot reply (reply tool `buttons`). One row per reply that offered buttons; the button
-- `value` is this row's id. The first press is claimed atomically (pressed_at is null → set); the press becomes a
-- synthetic user message (ts = pressed_message_ts) so context renders it like a reply.
create table reply_buttons (
  id bigserial primary key,
  thread_id text not null references threads(id) on delete cascade,
  channel_id text not null,
  turn_id bigint,
  idempotency_key text not null unique,        -- reply:<turn>:<index>: a retried turn reuses its row
  message_ts text,                             -- the message carrying the buttons (null until delivered)
  reply_text text,                             -- that message's markdown (re-rendered on press / card updates); null = buttons-only message
  labels jsonb not null,
  pressed_by text,
  pressed_label text,
  pressed_message_ts text,
  pressed_at timestamptz,
  created_at timestamptz not null default now()
);
create index reply_buttons_message_idx on reply_buttons (channel_id, message_ts);
create index reply_buttons_thread_idx on reply_buttons (thread_id);
