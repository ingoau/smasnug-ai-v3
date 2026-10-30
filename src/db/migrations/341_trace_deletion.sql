-- Trace deletion by channel (src/agent/trace.ts, docs/evals.md): a turn's input holds channel context, not just its
-- thread, so deleting a message in Slack drops every trace in its channel that ran after it was posted (applyDelete),
-- traces still in flight then are dropped when saved (messages.deleted_at), and the daily pass catches stragglers.
-- model: the configured model; steps[].model is the one that answered. outcome may also be 'interrupted' (shutdown,
-- or another worker finished the run).
alter table traces add column if not exists channel_id text;
update traces set channel_id = split_part(thread_id, ':', 1) where channel_id is null;
alter table traces alter column channel_id set not null;
create index if not exists traces_channel_idx on traces (channel_id, created_at);
create index if not exists traces_prompt_idx on traces (prompt_hash);

-- When a stored message was deleted in Slack (applyDelete), so traces taken while it was in flight can be matched.
alter table messages add column if not exists deleted_at timestamptz;
