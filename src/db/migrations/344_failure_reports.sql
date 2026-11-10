-- Failure reports (src/features/failures/): where the bot went wrong, for evals (docs/evals.md). Filed by the front
-- agent itself (report_failure, source 'self') or by the background review of idle threads (source 'review').
-- Same retention as traces: deleted after ~30 days, with the thread, and when a message in the channel is deleted.
create table if not exists failure_reports (
  id bigserial primary key,
  thread_id text not null references threads(id) on delete cascade,
  channel_id text not null,
  turn_id bigint references turns(id) on delete set null,
  source text not null check (source in ('self', 'review')),
  categories text[] not null,
  summary text not null,
  -- 'explicit_complaint' | 'correction' | 'self_noticed' | 'hindsight'
  signal text,
  -- [{ ts, userId, quote }]: the messages that show the failure (quotes copied from stored messages, not the model).
  evidence jsonb not null default '[]'::jsonb,
  -- The user whose request it was (privacy withdraw deletes their reports).
  speaker_id text,
  -- Self reports only, once the thread was reviewed: 'confirmed' | 'disputed'.
  review_verdict text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists failure_reports_thread_idx on failure_reports (thread_id);
create index if not exists failure_reports_turn_idx on failure_reports (turn_id);
create index if not exists failure_reports_created_idx on failure_reports (created_at);
create index if not exists failure_reports_channel_idx on failure_reports (channel_id, created_at);

-- When the failure review last looked at the thread (src/features/failures/review.ts).
alter table threads add column if not exists failures_reviewed_at timestamptz;
