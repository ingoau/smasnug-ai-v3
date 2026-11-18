-- Channel-scoped workspace facts ("channel rules"): a rule an admin or a channel's creator states for how the bot
-- behaves in one channel ("reminder requests here get only a ✅ reaction"). channel_id null = workspace-wide (the
-- existing facts, in the system prompt); set = only shown on turns in that channel (src/features/memory/rules.ts).
alter table workspace_facts add column if not exists channel_id text;
create index if not exists workspace_facts_channel_idx on workspace_facts (channel_id) where channel_id is not null and status = 'approved';
