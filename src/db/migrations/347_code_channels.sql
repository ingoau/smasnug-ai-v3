-- Code channels (docs/code-channels.md): Slack channels made for one session with the bot. One row per channel.
--
-- `thread_id` is the channel's top-level conversation (`${channel_id}:0`) and owns the row: when retention deletes
-- that thread (no activity for the retention window) the row goes with it, the same as any thread data. The thread
-- that opened the channel (`parent_thread_id`) can expire first; the link is then just cleared.
-- `seed_summary` / `brief` are copies of thread content: retention blanks them after the window (like messages) and
-- a privacy withdrawal blanks them for channels the person asked for or wrote in (src/features/code-channels/store.ts).
create table if not exists code_channels (
  channel_id text primary key,
  thread_id text not null unique references threads(id) on delete cascade,
  -- agents.conversations.create's session_id (≤ 64): derived from the triggering turn / press so retries return the
  -- same channel; adopted channels get one derived from the channel id.
  session_id text not null unique check (length(session_id) between 1 and 64),
  kind text not null check (kind in ('fork', 'task', 'adopted')),
  name text not null,
  parent_thread_id text references threads(id) on delete set null,
  -- The origin link passed to agents.conversations.create (or read from Slack for adopted ones): both or neither.
  origin_channel_id text,
  origin_ts text,
  -- The channel's first message (the fork summary or the brief), e.g. for "Moved → <link>".
  seed_ts text,
  seed_summary text,
  brief text,
  -- Who made it (the speaker whose turn called the tool, or who pressed the button) and who it was made for.
  created_by text,
  requester_id text,
  is_private boolean not null default false,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  -- Day-6 archive warning posted (reset by any message), and the archive itself (reset when reopened).
  warned_at timestamptz,
  archived_at timestamptz,
  check (thread_id = channel_id || ':0'),
  check ((origin_channel_id is null) = (origin_ts is null))
);

create index if not exists code_channels_idle_idx on code_channels (last_activity_at) where archived_at is null;
create index if not exists code_channels_parent_idx on code_channels (parent_thread_id) where parent_thread_id is not null;
