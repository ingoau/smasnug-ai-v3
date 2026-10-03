-- Agent module: subagent runs and plan cards.

-- Model used for a run (MODELS.child or MODELS.childHard).
alter table runs add column if not exists model text;

-- One card per turn that started runs.
create unique index if not exists cards_turn_uidx on cards (turn_id) where turn_id is not null;

-- Card lookup for runs and sweeper scans.
create index if not exists runs_card_idx on runs (card_id);
create index if not exists runs_running_heartbeat_idx on runs (heartbeat_at) where status = 'running';
create index if not exists subagent_inbox_pending_idx on subagent_inbox (subagent_id) where consumed_at is null;
