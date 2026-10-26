-- Privacy policy consent (src/features/privacy.ts): one row per user per policy version (a hash of PRIVACY.md).
create table if not exists privacy_consent (
  user_id text not null,
  policy_version text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, policy_version)
);

-- Messages held until their author agrees (src/pipeline/consent.ts), replayed on agreement; retention clears the rest.
create table if not exists privacy_held (
  id bigserial primary key,
  user_id text not null,
  item jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists privacy_held_user_idx on privacy_held (user_id);
