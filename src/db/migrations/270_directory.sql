-- Workspace directory (src/tools/directory/): people (users + bots) and PUBLIC channels, filled by a background crawl
-- (users.list / conversations.list), Slack events (user_change, team_join, channel_*) and write-through from every
-- users.info lookup. It is the bot's one profile store (it replaced the Redis users.info cache).
-- Searchable (trigram-indexed, matched by find_people / find_channels): handle, display name, real name, title;
-- channel name, topic, purpose. Everything else is display-only and must never be indexed or matched.
create extension if not exists pg_trgm;

create table directory_people (
  id text primary key,                         -- Slack user id
  handle text not null default '',             -- users.list `name`                       (searchable)
  display_name text not null default '',       -- profile.display_name                    (searchable)
  real_name text not null default '',          -- profile.real_name / real_name           (searchable)
  title text not null default '',              -- profile.title                           (searchable)
  -- Display-only (never indexed, never matched, no filters):
  pronouns text not null default '',
  tz text,
  tz_offset int,
  locale text,                                 -- only from users.info / users.list with include_locale
  status_text text not null default '',
  status_emoji text not null default '',
  status_expiration bigint,                    -- unix seconds; null = never. Dropped at render time once past.
  is_admin boolean not null default false,
  is_owner boolean not null default false,
  is_primary_owner boolean not null default false,
  -- Kind / state:
  is_bot boolean not null default false,
  is_app_user boolean not null default false,
  deleted boolean not null default false,      -- deactivated account (Slack `deleted`)
  synced_at timestamptz not null default now(),  -- last full profile from Slack (crawl, users.info or an event)
  updated_at timestamptz not null default now(), -- last change of a stored field
  -- The searchable fields in one trigram index (one GIN index instead of four: cheaper writes, and the planner uses
  -- it; an OR over four column indexes fell back to a ~250 ms seq scan on 150k rows). Pronouns etc. are NOT in it.
  search_text text generated always as (lower(handle || ' ' || display_name || ' ' || real_name || ' ' || title)) stored
);
create index directory_people_search_trgm on directory_people using gin (search_text gin_trgm_ops);
create index directory_people_synced_idx on directory_people (synced_at);

-- Public channels only: private channels are never stored, even ones the bot is in.
create table directory_channels (
  id text primary key,
  name text not null,
  topic text not null default '',
  purpose text not null default '',
  is_private boolean not null default false check (not is_private),
  is_archived boolean not null default false,
  member_count int,
  created_at timestamptz,
  synced_at timestamptz not null default now(),  -- last confirmed by the crawl or an event
  updated_at timestamptz not null default now()
);
create index directory_channels_name_trgm on directory_channels using gin (name gin_trgm_ops);
create index directory_channels_topic_trgm on directory_channels using gin (topic gin_trgm_ops);
create index directory_channels_purpose_trgm on directory_channels using gin (purpose gin_trgm_ops);
create index directory_channels_synced_idx on directory_channels (synced_at);

-- Crawl state per kind: a running crawl's next cursor (resumable across restarts) and the last complete crawl.
create table directory_crawls (
  kind text primary key check (kind in ('people', 'channels')),
  running boolean not null default false,
  started_at timestamptz,                      -- start of the running (or last) crawl
  cursor text,                                 -- next page of the running crawl ('' = first page)
  pages int not null default 0,                -- pages done in the running crawl
  rows_seen int not null default 0,            -- rows seen in the running crawl
  progress_at timestamptz,                     -- last page done (a running crawl without progress is resumed)
  finished_at timestamptz,                     -- end of the last complete crawl (null: never completed)
  last_total int                               -- rows seen by the last complete crawl (progress estimate)
);
