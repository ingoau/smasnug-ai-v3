-- Per-user memory (src/features/memory): a kind per fact (preferences are always injected, the rest by relevance),
-- when the fact was last stated (shown as its age, so stale project facts can be hedged), and full-text search for
-- relevance-based injection and search_memory (ranked per user at query time, at most a few hundred rows: no index).
alter table user_memory add column if not exists kind text not null default 'about';
alter table user_memory add column if not exists stated_at timestamptz;
update user_memory set stated_at = created_at where stated_at is null;
alter table user_memory alter column stated_at set default now();
alter table user_memory alter column stated_at set not null;
-- Best-effort backfill: facts phrased as preferences.
update user_memory set kind = 'preference'
where kind = 'about' and text ~* '^(prefers|likes|dislikes|hates|wants|doesn''t want|does not want|loves|would rather)\M';
