-- Canvases the bot created with create_canvas (src/tools/canvases.ts). Only these can be edited (edit_canvas), and
-- only from the conversation they were created in or by the speaker who asked for them. No content is stored (the
-- canvas lives in Slack and is never deleted by the bot); a row only says "the bot made this, here, for this person".
-- No FK to threads: a deliverable outlives thread retention. Rows expire after limits.canvasRowExpiryMs without use.
create table bot_canvases (
  canvas_id text primary key,
  create_key text not null unique,      -- idempotency: turn + hash of title and content
  channel_id text not null,
  thread_id text not null,
  creator_id text not null,             -- the speaker who asked for it
  turn_id bigint,
  title text not null,
  permalink text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index bot_canvases_last_used_idx on bot_canvases (last_used_at);
