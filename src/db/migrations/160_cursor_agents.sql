-- Coding agents (Cursor Cloud Agents, src/agent/cursor/). A subagent of kind 'cursor' is backed by one Cursor agent;
-- each of its runs (one plan-card row) by one or more Cursor runs: a steer that arrives while Cursor is working is sent
-- as a follow-up Cursor run within the same bot run. Rows follow the subagent/run retention (cascade).
alter table subagents add column kind text not null default 'model';  -- model | cursor
alter table subagents add column cursor_agent_id text;               -- 'bc-<uuid>', client-supplied on create (idempotent)
alter table subagents add column cursor_agent_url text;

-- Polling state of a bot run backed by Cursor. Pollers claim one due row at a time (claim_id + lease), like reminders.
create table cursor_runs (
  run_id bigint primary key references runs(id) on delete cascade,
  agent_id text not null,
  cursor_run_id text,                       -- current Cursor run (null until the launch call returned)
  cursor_status text,                       -- last status seen: CREATING | RUNNING | FINISHED | ERROR | CANCELLED | EXPIRED
  follow_ups int not null default 0,        -- follow-up Cursor runs sent within this bot run (queued steers)
  pr_url text,
  branch text,
  next_poll_at timestamptz not null default now(),
  claim_id uuid,
  claimed_until timestamptz,
  poll_errors int not null default 0,       -- consecutive failed polls
  last_error text,
  last_polled_at timestamptz,
  created_at timestamptz not null default now()
);
create index cursor_runs_due_idx on cursor_runs (next_poll_at);
