-- Reports the bot itself files about the current speaker (report_user tool). Separate from `reports` (human reports
-- on on-behalf sends): bot reports never count towards auto-suspension.
create table bot_reports (
  id bigserial primary key,
  user_id text not null,                       -- the reported speaker
  category text not null,
  reason text not null,
  channel_id text not null,
  message_ts text,                             -- the reported message (null if unknown)
  thread_id text not null,                     -- no FK: a pending report outlives thread retention
  permalink text,
  snapshot text,                               -- the reported message text at report time
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
  idempotency_key text not null unique,        -- one report per (thread, turn)
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);
create index bot_reports_user_created_idx on bot_reports (user_id, created_at);
create index bot_reports_status_idx on bot_reports (status, created_at);
