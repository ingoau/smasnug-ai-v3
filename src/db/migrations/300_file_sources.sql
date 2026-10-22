-- Slack files seen outside the bot's own conversation (read_public_thread / read_public_channel, slack_search,
-- ask_thread) get file ids too: they are registered as uploads in the thread that saw them, with the channel their
-- message is in. `source_public`: that channel was verified public, so the download may fall back to the user token
-- (the bot token only reaches channels the bot is in).
alter table files add column if not exists source_channel_id text;   -- null: the message is in channel_id
alter table files add column if not exists source_public boolean not null default false;
create index if not exists files_source_message_idx on files (source_channel_id, message_ts) where source_channel_id is not null;
