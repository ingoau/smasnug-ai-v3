-- HuddleFM DJ mode (src/features/huddlefm): the bot controls the music in a Slack huddle through HuddleFM's bot API
-- (JSON DMs to the HuddleFM user, approved by the huddle host). One row per huddle channel while DJ mode is pending
-- or active; the row is deleted when DJ mode ends (turned off, declined, expired, revoked, session ended, grant lost).
create table dj_sessions (
  id serial primary key,                        -- a new request for the channel is a new row (and id)
  channel_id text not null unique,              -- the huddle channel (HuddleFM's `channel`)
  status text not null,                         -- pending | active
  request_ts text,                              -- ts of our request_control DM: HuddleFM's replyTo for grant_* replies
  requested_by text not null,                   -- who asked; the speaker of announcement turns
  origin_thread_id text not null,               -- where DJ mode was asked for: announcements and chatter go there
  auto_dj boolean not null default true,        -- the bot keeps the queue topped up with its own picks
  chatter boolean not null default false,       -- a short line in the origin thread now and then when a song starts
  vibe text,                                    -- what people asked the auto DJ for ("90s rnb", "no sad stuff")
  permissions text[] not null default '{}',     -- what the host granted
  picks text[] not null default '{}',           -- the auto DJ's recent picks ("title - artist"), newest last
  requested text[] not null default '{}',       -- songs people queued themselves (taste signal), newest last
  skipped text[] not null default '{}',         -- auto DJ picks people skipped (steer away), newest last
  played text[] not null default '{}',          -- recently started tracks, newest last
  playback jsonb,                               -- last status snapshot: { nowPlaying, queue, queueLength, at }
  topup_failures int not null default 0,        -- consecutive top-ups that added nothing (backoff)
  last_event_at timestamptz,                    -- last HuddleFM event for this channel (liveness)
  last_chatter_at timestamptz,
  last_notice_at timestamptz,                   -- last non-chatter notice (e.g. a failed download), rate limit
  granted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index dj_sessions_origin_idx on dj_sessions (origin_thread_id);
