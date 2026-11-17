-- Code channels' Status tab (docs/code-channels.md, Status tab; src/features/code-channels/status.ts) lists the runs
-- started from any conversation in a channel (its `:0` conversation and threads under its messages), found by the
-- channel part of the thread id.
create index if not exists runs_channel_idx on runs ((split_part(thread_id, ':', 1)), id);
