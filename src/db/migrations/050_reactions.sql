-- Reactions on stored messages, kept current from reaction_added / reaction_removed events and backfills.
-- Shape: [{ "name": "+1", "users": ["U123", ...], "count": 2 }] (count can exceed users.length for backfilled rows).
alter table messages add column if not exists reactions jsonb not null default '[]'::jsonb;
