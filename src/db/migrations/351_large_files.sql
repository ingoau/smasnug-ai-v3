-- Large files (src/files/large.ts): created files over limits.fileMaxBytes keep their bytes in Slack, as a private
-- upload of the bot's (never shared anywhere), instead of in files.content. Posting one copies it into the thread.
alter table files add column if not exists blob_slack_file_id text;

-- Every such Slack upload, kept after its file row is gone (no FK): retention deletes file rows, and the Slack copies
-- of deleted rows are then deleted from Slack (files.delete) by sweepLargeFileBlobs.
create table if not exists file_blobs (
  slack_file_id text primary key,
  file_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists file_blobs_file_idx on file_blobs (file_id);
