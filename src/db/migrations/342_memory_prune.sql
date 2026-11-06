-- Memory prune pass (src/features/memory/prune.ts): when each user's facts were last reviewed, and what a pass removed or
-- merged (the original text, so a bad prune can be undone by hand). Rows expire with retention and go with "forget everything".
create table memory_prune_state (
  user_id text primary key,
  pruned_at timestamptz not null default now()
);

create table memory_pruned (
  id bigserial primary key,
  user_id text not null,
  fact_id bigint not null,
  kind text not null,
  text text not null,
  stated_at timestamptz not null,
  action text not null check (action in ('removed', 'merged')),
  merged_into bigint,
  reason text,
  created_at timestamptz not null default now()
);
create index memory_pruned_user_idx on memory_pruned (user_id, created_at desc);
