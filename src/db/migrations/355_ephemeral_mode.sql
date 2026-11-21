-- Ephemeral mode (`@bot !p …`, docs/design.md "When the bot responds"): the turn's answer is shown only to its
-- author (chat.postEphemeral). Its cards never post, its subagents are private to the author (hidden from other
-- turns), and every results turn of such a card is ephemeral too.
alter table turns add column if not exists ephemeral boolean not null default false;
alter table cards add column if not exists ephemeral boolean not null default false;
alter table subagents add column if not exists private_to text;

-- One private answer: what the "Send to thread" button posts publicly (shared_ts once it did).
create table if not exists ephemeral_replies (
  id bigserial primary key,
  thread_id text not null,
  channel_id text not null,
  user_id text not null,
  turn_id bigint,
  text text not null,
  extras jsonb,
  files jsonb not null default '[]'::jsonb,
  shared_ts text,
  -- When a "Send to thread" press claimed it (shared_ts 'pending'): a claim left by a crash can be retaken later.
  share_claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ephemeral_replies_created_idx on ephemeral_replies (created_at);
