-- features module: sends, reports, memory, retention helpers.

-- Raw destination of an on-behalf send (channel id, or user id for DMs) and the pending send it came from.
alter table sent_messages add column destination text;
alter table sent_messages add column pending_send_id uuid;
create index sent_messages_requester_idx on sent_messages (requester_id);

-- Reports count towards auto-suspension until the admin reviews (unsuspends) the sender.
alter table reports add column reviewed_at timestamptz;
create index reports_sent_message_idx on reports (sent_message_id);

-- Memory expiry / injection order
create index user_memory_last_used_idx on user_memory (user_id, last_used desc);

create index workspace_facts_status_idx on workspace_facts (status);
create index pending_sends_requester_idx on pending_sends (requester_id, status);

-- Retention sweeps
create index thread_events_created_idx on thread_events (created_at);
create index usage_created_idx on usage (created_at);
create index usage_user_kind_idx on usage (user_id, kind, created_at);
create index threads_last_activity_idx on threads (last_activity_at);
create index idempotency_keys_created_idx on idempotency_keys (created_at);
create index if not exists slack_events_seen_received_idx on slack_events_seen (received_at);
