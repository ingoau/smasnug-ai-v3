-- Fixes for coding agents (src/agent/cursor/) and reminders (src/features/schedule/).

-- Times a poller deferred finishing a coding-agent run because steers arrived meanwhile ('inbox'); bounded
-- (agents.ts MAX_INBOX_DEFERS) so a run can never be re-polled forever. Reset when a follow-up is sent.
alter table cursor_runs add column inbox_defers int not null default 0;
