-- Core schema. Thread id is always `${channel_id}:${thread_ts}` (thread_ts = root message ts; for DMs the
-- root ts of the DM thread, or the message ts if top-level).

-- Slack event dedupe (event_id, retries)
create table slack_events_seen (
  event_id text primary key,
  received_at timestamptz not null default now()
);

create table threads (
  id text primary key,
  channel_id text not null,
  thread_ts text not null,
  is_dm boolean not null default false,
  engaged boolean not null default false,          -- bot has been mentioned / is following
  last_addressed_at timestamptz,
  messages_since_addressed int not null default 0,
  backfilled boolean not null default false,       -- history pulled from conversations.replies
  next_image_n int not null default 1,
  last_activity_at timestamptz not null default now(),
  memory_extracted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Stored copies of Slack messages in threads the bot cares about (incl. channel context messages).
create table messages (
  channel_id text not null,
  ts text not null,
  thread_id text references threads(id) on delete cascade,  -- null for channel context messages
  user_id text,
  bot_id text,
  username text,
  text text not null default '',
  files jsonb not null default '[]',
  edited_at timestamptz,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (channel_id, ts)
);
create index messages_thread_idx on messages (thread_id, ts);

-- Append-only per-thread event log. types (non-exhaustive):
-- message, message_edited, message_deleted, gate_decision, turn_started, turn_finished, discarded_text,
-- reply, reaction, spawn, steer, run_started, run_progress, run_finished, card_posted, send, error
create table thread_events (
  id bigserial primary key,
  thread_id text not null references threads(id) on delete cascade,
  type text not null,
  actor text,                                       -- slack user id, 'bot', 'subagent:<id>', 'system'
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index thread_events_thread_idx on thread_events (thread_id, id);

-- A turn request = one debounced batch from one author (or a synthesis request).
create table turns (
  id bigserial primary key,
  thread_id text not null references threads(id) on delete cascade,
  author_id text not null,
  kind text not null default 'user',               -- 'user' | 'synthesis'
  is_mention boolean not null default false,
  message_ts text[] not null default '{}',
  card_id bigint,                                   -- synthesis: the card whose runs finished
  status text not null default 'pending',          -- pending | running | done | cancelled | error
  phase text,                                       -- running: 'tools' | 'final'
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index turns_pending_idx on turns (thread_id, id) where status in ('pending', 'running');

-- Messages pushed to a running front-agent turn (same author, tool boundary coming).
create table thread_inbox (
  id bigserial primary key,
  turn_id bigint not null references turns(id) on delete cascade,
  message_ts text not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Plan cards: one per turn that started runs.
create table cards (
  id bigserial primary key,
  thread_id text not null references threads(id) on delete cascade,
  turn_id bigint references turns(id) on delete set null,
  channel_id text not null,
  message_ts text,                                  -- set once posted
  title text,                                       -- set by set_card_title on finish
  frozen boolean not null default false,
  synthesized boolean not null default false,
  created_at timestamptz not null default now()
);

create table subagents (
  id text primary key,                              -- 'sa_' + short id
  thread_id text not null references threads(id) on delete cascade,
  owner_id text not null,
  title text not null,
  status text not null default 'idle',             -- running | idle | cancelled | expired
  summary text,                                     -- one-line summary of latest result
  history jsonb not null default '[]',              -- AI SDK ModelMessage[] (compacted)
  seeded_from text,                                 -- expired subagent this was seeded from
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);
create index subagents_thread_idx on subagents (thread_id);

create table runs (
  id bigserial primary key,
  subagent_id text not null references subagents(id) on delete cascade,
  thread_id text not null references threads(id) on delete cascade,
  card_id bigint references cards(id) on delete set null,
  turn_id bigint references turns(id) on delete set null,
  instructions text not null,
  is_resume boolean not null default false,
  status text not null default 'queued',           -- queued | running | complete | error | cancelled
  details text,                                     -- current step
  steer_notes jsonb not null default '[]',          -- ["also checking #ship"]
  output text,                                      -- one-line result for the card
  result text,                                      -- full result for the front agent
  error text,
  cancel_requested boolean not null default false,
  reported boolean not null default false,          -- included in a synthesis
  tokens int not null default 0,
  worker_id text,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index runs_active_idx on runs (thread_id) where status in ('queued', 'running');

create table subagent_inbox (
  id bigserial primary key,
  subagent_id text not null references subagents(id) on delete cascade,
  text text not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Stable per-thread image ids (img_N)
create table thread_images (
  thread_id text not null references threads(id) on delete cascade,
  n int not null,
  file_id text not null,
  name text,
  mimetype text,
  url_private text,
  from_user text,
  message_ts text,
  primary key (thread_id, n),
  unique (thread_id, file_id)
);

-- Idempotency for side effects
create table idempotency_keys (
  key text primary key,
  result jsonb,
  created_at timestamptz not null default now()
);

-- Memory
create table user_memory (
  id bigserial primary key,
  user_id text not null,
  text text not null,
  source_thread text,
  created_at timestamptz not null default now(),
  last_used timestamptz not null default now()
);
create index user_memory_user_idx on user_memory (user_id);

create table workspace_facts (
  id bigserial primary key,
  text text not null,
  source_thread text,
  proposer_id text not null,
  status text not null default 'pending',          -- pending | approved | rejected
  mod_message_ts text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- Sending on behalf of users
create table pending_sends (
  id uuid primary key default gen_random_uuid(),
  requester_id text not null,
  thread_id text references threads(id) on delete set null,
  destination text not null,                        -- channel id, or user id for DM
  text text not null,
  files jsonb not null default '[]',
  status text not null default 'pending',          -- pending | sent | cancelled | expired
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table sent_messages (
  id bigserial primary key,
  channel_id text not null,
  ts text not null,
  requester_id text not null,
  text text not null,
  permalink text,
  created_at timestamptz not null default now(),
  unique (channel_id, ts)
);

create table reports (
  id bigserial primary key,
  sent_message_id bigint not null references sent_messages(id) on delete cascade,
  reporter_id text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (sent_message_id, reporter_id)
);

-- Blocks / suspensions (shared block list)
create table user_blocks (
  user_id text primary key,
  suspended boolean not null default false,        -- blocked at every entry point
  send_blocked boolean not null default false,     -- blocked from send_message only
  reason text,
  created_at timestamptz not null default now()
);

-- Kill switches etc: key 'paused' -> true, 'channel_disabled:<C>' -> true
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Usage counters for limits that need durability (rate windows live in Redis)
create table usage (
  id bigserial primary key,
  user_id text,
  thread_id text,
  kind text not null,                               -- model | search | fetch | send
  model text,
  input_tokens int,
  output_tokens int,
  created_at timestamptz not null default now()
);
