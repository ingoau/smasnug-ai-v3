-- Fixes for coding agents (src/agent/cursor/) and reminders (src/features/schedule/).

-- Times a poller deferred finishing a coding-agent run because steers arrived meanwhile ('inbox'); bounded
-- (agents.ts MAX_INBOX_DEFERS) so a run can never be re-polled forever. Reset when a follow-up is sent.
alter table cursor_runs add column inbox_defers int not null default 0;

-- A follow-up run whose create call's answer was lost (timeout): the agent's latest Cursor run before it, so the
-- poller's "look the agent up" recovery doesn't adopt the previous (finished) run as the new one.
alter table cursor_runs add column after_run_id text;

-- Reminder retries back off (1, 2, 5, 10 min) instead of being re-claimed at once: a reminder whose fire attempt
-- failed is due again at retry_at (pollers claim rows where coalesce(retry_at, due_at) <= now()).
alter table reminders add column retry_at timestamptz;
create index reminders_next_fire_idx on reminders ((coalesce(retry_at, due_at))) where status in ('pending', 'firing');
