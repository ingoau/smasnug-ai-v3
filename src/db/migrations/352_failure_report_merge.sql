-- Failure reports about the same incident are merged at insert time (src/features/failures/store.ts recordFailure): a
-- second report on the same turn or citing an overlapping message folds into the first. The folded-in report's
-- idempotency key is kept here so a retry (or a re-review) still finds it and doesn't merge again.
alter table failure_reports add column if not exists merged_keys text[] not null default '{}';
