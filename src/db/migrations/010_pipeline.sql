-- Pipeline module additions.

-- Inbox rows remember whether the pushed message was a mention/DM, so leftovers moved into a new turn keep the flag.
alter table thread_inbox add column is_mention boolean not null default false;
create index thread_inbox_unconsumed_idx on thread_inbox (turn_id) where consumed_at is null;
