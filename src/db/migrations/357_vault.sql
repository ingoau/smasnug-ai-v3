-- Vault (docs/vault.md): per-user credentials, owner approvals, short grants, audit log.
-- Secrets are AES-256-GCM with a per-user key derived from VAULT_SECRET_KEY (never stored here).

create table vault_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  name text not null,
  -- token: an API key / bearer token (fetch_with_credential, sandbox env); login: username + password (browser);
  -- connector: an MCP connector's API key or OAuth state; browser_session: saved cookies + localStorage.
  kind text not null check (kind in ('token', 'login', 'connector', 'browser_session')),
  service text,
  -- Non-secret settings shown to the owner and the model: domains, header, scheme, env var, connector slug.
  meta jsonb not null default '{}',
  secret_enc bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (owner_id, name)
);
create index vault_credentials_owner on vault_credentials (owner_id);

-- An owner's approval card. mode 'wait': a subagent's tool polls the row; 'outcome': on approval the kind's executor
-- runs and its result reaches the front agent as an outcome turn (source 'approval').
create table vault_approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  credential_id uuid references vault_credentials (id) on delete cascade,
  kind text not null,
  mode text not null check (mode in ('wait', 'outcome')),
  thread_id text not null,
  title text not null,
  detail jsonb not null default '[]',
  -- What the executor needs (e.g. a connector call's arguments); encrypted like a secret, nulled once settled.
  payload_enc bytea,
  allow_window boolean not null default true,
  -- The grant "Allow for 10 min here" creates (vault_grants.grant_key); null = no window option.
  grant_key text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  -- once | window (approved for vaultGrantMs in this thread)
  scope text,
  card_channel text,
  card_ts text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  -- outcome mode: set once the outcome turn was created (exactly once).
  settled_at timestamptz
);
create index vault_approvals_pending on vault_approvals (expires_at) where status = 'pending';
create index vault_approvals_owner on vault_approvals (owner_id);

-- "Allow for 10 minutes in this thread": a credential (or a connector, by key) the owner pre-approved.
create table vault_grants (
  owner_id text not null,
  grant_key text not null,          -- 'cred:<uuid>' or 'conn:<slug>:<tool>'
  thread_id text not null,
  expires_at timestamptz not null,
  primary key (owner_id, grant_key, thread_id)
);

create table vault_audit (
  id bigserial primary key,
  owner_id text not null,
  credential_id uuid,
  credential_name text not null,
  action text not null,             -- e.g. fetch, sandbox_env, browser_fill, session_load, connector_call, created, deleted
  tool text,
  thread_id text,
  outcome text not null,            -- ok | denied | refused | error | approved | expired
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index vault_audit_owner on vault_audit (owner_id, at desc);
