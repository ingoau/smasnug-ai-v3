-- Code channels (docs/code-channels.md, Lifecycle): a close that keeps failing (archive refused: not_authorized,
-- restricted_action, Slack down) doesn't write a new closing summary every hourly sweep. The summary written by the
-- first attempt is kept (`closing_summary`, a copy of thread content: retention and a privacy withdrawal blank it
-- like `seed_summary`), and the sweep backs off: `close_failures` attempts so far, the next one not before
-- `close_retry_at`. After the last attempt (or a refusal that won't change) the sweep stops trying (`close_failures`
-- at the cap); any message in the channel resets all three.
alter table code_channels
  add column if not exists closing_summary text,
  add column if not exists close_failures integer not null default 0,
  add column if not exists close_retry_at timestamptz;
