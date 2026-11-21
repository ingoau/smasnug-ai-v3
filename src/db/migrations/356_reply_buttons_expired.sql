-- Quick-reply buttons left unpressed when the bot answers a newer message in the thread are retired (hidden, no longer
-- pressable): the conversation moved on. Null = still live.
alter table reply_buttons add column if not exists expired_at timestamptz;
