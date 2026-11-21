-- Previews deploy inline in the subagent's run (docs/sandbox.md §3.6): a run may deploy again after a fix, so one
-- run can have several previews; inline_until marks a request_preview call waiting for the terms answer (the accept
-- handler then leaves the deploy to that call instead of queueing it).
drop index if exists previews_run_idx;
create index if not exists previews_run_id_idx on previews (run_id) where run_id is not null;
alter table previews add column if not exists inline_until timestamptz;
