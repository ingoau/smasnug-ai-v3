-- Agent session state of DM threads (src/pipeline/agent-session.ts): the sidebar title and who chose it, and a
-- `closed` request for the end of a turn. One row per DM thread; dropped with the thread (retention).
create table agent_sessions (
  thread_id text primary key references threads(id) on delete cascade,
  title text,                         -- the session title as far as we know (ours or the user's)
  title_by text,                      -- 'bot' (set_session_title) | 'user' (renamed in Slack: never overwritten)
  title_turn_id bigint,               -- the turn that last set the bot title (one title per turn)
  bot_title_at timestamptz,           -- when we last renamed it (tells our own rename's echo from a user rename)
  user_renamed_at timestamptz,
  close_turn_id bigint,               -- leave_thread in a DM: that turn ends with the session `closed`
  updated_at timestamptz not null default now()
);
