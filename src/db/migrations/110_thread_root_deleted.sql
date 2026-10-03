-- The thread's root message was deleted: Slack would post replies with that thread_ts as top-level channel
-- messages, so nothing may be posted into the thread anymore.
alter table threads add column root_deleted_at timestamptz;
