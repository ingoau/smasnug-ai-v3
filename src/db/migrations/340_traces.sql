-- Model traces for evals (src/agent/trace.ts, `pnpm eval:export`, docs/evals.md): what the model saw and did in each
-- front turn and subagent run (input, per-step text/reasoning/tool calls with clipped results, usage, timing).
-- Thread data: cascades with the thread, goes after the retention window, and is dropped when a message in its
-- thread is deleted in Slack (it may hold a copy).
create table if not exists prompt_versions (
  hash text primary key,                            -- sha256 of the system prompt text (first 16 hex chars)
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists traces (
  id bigserial primary key,
  thread_id text not null references threads(id) on delete cascade,
  kind text not null,                               -- 'front' | 'run'
  turn_id bigint,                                   -- front: the turn; run: the turn that spawned it (if known)
  run_id bigint,
  model text,
  prompt_hash text,                                 -- prompt_versions.hash
  git_sha text,
  input jsonb not null default '[]',                -- the messages the call started from (clipped)
  steps jsonb not null default '[]',                -- TraceStep[] (trace.ts)
  outcome text,                                     -- done | stopped | error | cancelled | timeout
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists traces_thread_idx on traces (thread_id);
create index if not exists traces_turn_idx on traces (turn_id);
create index if not exists traces_run_idx on traces (run_id);
create index if not exists traces_created_idx on traces (created_at);
