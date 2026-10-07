-- DM session titles (src/pipeline/agent-session.ts): failed renames in a row and when the last one failed, so the
-- background title job backs off instead of calling the model every turn (titleBackoffActive). Reset on success.
alter table agent_sessions
  add column title_failures int not null default 0,
  add column title_failed_at timestamptz;
