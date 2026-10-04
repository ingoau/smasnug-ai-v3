-- Reminders and watches (src/features/schedule). thread_id has no foreign key on purpose: a reminder can be due
-- long after retention deleted an idle thread; the thread row is recreated when it fires.

create table reminders (
  id bigserial primary key,
  owner_id text not null,
  thread_id text not null,
  channel_id text not null,
  text text not null,
  due_at timestamptz not null,
  tz text,                                          -- owner's time zone when set (for display)
  status text not null default 'pending',          -- pending | firing | fired | skipped | cancelled | failed
  skip_reason text,                                -- skipped/failed: why (paused, suspended, bot_removed, …)
  claim_id uuid,                                   -- firing: the poller that holds the lease
  claimed_until timestamptz,
  attempts int not null default 0,
  turn_id bigint,                                  -- fired: the scheduled turn
  fired_thread_id text,                            -- fired: where (the DM fallback when the thread is gone)
  fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reminders_due_idx on reminders (due_at) where status in ('pending', 'firing');
create index reminders_owner_idx on reminders (owner_id, status);

create table watches (
  id bigserial primary key,
  owner_id text not null,
  thread_id text not null,
  channel_id text not null,
  source text not null,                            -- url | web_search | slack_search
  target text not null,                            -- URL or query
  criteria text not null,
  interval_s int not null,
  status text not null default 'active',           -- active | cancelled | expired
  state jsonb not null default '{}',               -- per-source baseline (page text + hash, seen URLs, last ts)
  checks int not null default 0,                   -- claim counter; check_no of the current check
  next_check_at timestamptz not null,
  last_checked_at timestamptz,
  last_result text,                                -- short outcome of the last check (debugging)
  expires_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index watches_due_idx on watches (next_check_at) where status = 'active';
create index watches_owner_idx on watches (owner_id, status);

-- At most one notification per watch per check (unique), and the daily cap counts these.
create table watch_notifications (
  id bigserial primary key,
  watch_id bigint not null references watches(id) on delete cascade,
  check_no int not null,
  turn_id bigint,
  summary text,
  created_at timestamptz not null default now(),
  unique (watch_id, check_no)
);
create index watch_notifications_recent_idx on watch_notifications (watch_id, created_at);

-- Input for a turn of kind 'scheduled' (a fired reminder or a watch notification), rendered by the front agent in
-- place of new messages. Written in the same transaction as the turn.
create table scheduled_turn_inputs (
  turn_id bigint primary key references turns(id) on delete cascade,
  source text not null,                            -- reminder | watch
  source_id bigint not null,
  input text not null,
  created_at timestamptz not null default now()
);
