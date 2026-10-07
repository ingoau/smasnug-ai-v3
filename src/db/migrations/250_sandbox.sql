-- Code sandboxes and live previews (src/sandbox/, docs/sandbox.md §3.8).

-- Spawn-time flag: only these subagents get the sandbox tools (and the longer run cap).
alter table subagents add column if not exists sandbox boolean not null default false;

-- One sandbox per subagent. The live provider sandbox (provider_id) or its pause (paused_ref, a filesystem snapshot).
create table sandboxes (
  id text primary key,                              -- 'sbx_' + short id
  subagent_id text unique references subagents(id) on delete set null,  -- set null: the sweep still destroys it
  thread_id text not null,
  owner_id text not null,
  provider text not null,
  provider_id text,                                 -- live sandbox (null while paused / after destroy)
  paused_ref text,                                  -- snapshot image id
  paused_expires_at timestamptz,
  image text not null,
  cpu real not null,
  memory_mib int not null,
  state text not null,                              -- creating|running|pausing|paused|resuming|destroying|destroyed|lost
  generation int not null default 0,                -- bumped on every create/resume; stale pause jobs are no-ops
  idle_since timestamptz,
  live_since timestamptz,                           -- start of the current live segment
  last_used_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sandboxes_state_check check (state in ('creating', 'running', 'pausing', 'paused', 'resuming', 'destroying', 'destroyed', 'lost'))
);
create index sandboxes_state_idx on sandboxes (state) where state not in ('destroyed');
create index sandboxes_owner_idx on sandboxes (owner_id, state);

-- Cost accounting: one row per live segment (create/resume → pause/destroy) of a work or deploy sandbox.
create table sandbox_usage (
  id bigserial primary key,
  sandbox_id text,
  preview_id text,
  user_id text,
  thread_id text,
  cpu real not null,                                -- the billed upper bound (cpu limit)
  memory_mib int not null,                          -- the billed upper bound (memory limit)
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  est_usd numeric(10,5)                             -- set when closed; open segments are accrued live
);
create index sandbox_usage_open_idx on sandbox_usage (sandbox_id) where ended_at is null;
create index sandbox_usage_started_idx on sandbox_usage (started_at);
create index sandbox_usage_user_idx on sandbox_usage (user_id, started_at);

-- Month totals (no personal data; kept): our estimate and, when Modal answers, its metered cost.
create table sandbox_spend_monthly (
  month date primary key,
  est_usd numeric(10,4) not null default 0,
  modal_env_usd numeric(10,4),
  modal_workspace_usd numeric(10,4),
  alerted_80 boolean not null default false,
  stopped boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Admin-managed allowlist (App Home).
create table sandbox_allowlist (
  user_id text primary key,
  added_by text not null,
  note text,
  created_at timestamptz not null default now()
);

-- Hack Club identity verification: only definitive answers, only a boolean (never the age bracket or status).
-- verified=true rows are the "last known positive" used when HCA can't be reached.
create table hca_verifications (
  user_id text primary key,
  verified boolean not null,
  checked_at timestamptz not null
);

-- Consent record: the requester accepted Cloudflare's terms for temporary deployments.
create table preview_terms (
  user_id text not null,
  terms_version text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, terms_version)
);

create table previews (
  id text primary key,                              -- 'pv_' + short id
  run_id bigint,
  subagent_id text,
  thread_id text not null,
  requester_id text not null,
  title text not null,
  bundle_file_id text,                              -- internal file-store file (tar), deleted when the preview ends
  status text not null,                             -- requested|awaiting_terms|deploying|live|expired|failed|refused|cancelled|taken_down
  worker_name text,
  url text,
  account_id text,
  api_token_enc bytea,                              -- AES-256-GCM (PREVIEW_SECRET_KEY); nulled at expiry/takedown
  claim_url_enc bytea,
  expires_at timestamptz,
  claim_expires_at timestamptz,
  message_ts text,
  terms_prompt_expires_at timestamptz,
  claim_id text,
  claim_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint previews_status_check check (status in ('requested', 'awaiting_terms', 'deploying', 'live', 'expired', 'failed', 'refused', 'cancelled', 'taken_down'))
);
create unique index previews_run_idx on previews (run_id) where run_id is not null;
create index previews_status_idx on previews (status) where status in ('requested', 'awaiting_terms', 'deploying', 'live');
create index previews_requester_idx on previews (requester_id, created_at);
