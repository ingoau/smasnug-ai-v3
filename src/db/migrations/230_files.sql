-- File store (src/files/): global storage, thread-scoped access (src/files/access.ts). One row per file the bot
-- made (`created`) and per Slack upload seen in a thread (`upload`, one row per thread it appears in). Uploads are
-- registered with metadata only; their content is downloaded with the bot token on first use. Content lives here
-- (bytea, at most limits.fileMaxBytes) behind the FileStore interface, so it can move elsewhere later.
-- Written idempotently (if not exists / to_regclass) so the img_N data move below can be re-run by its test.
create table if not exists files (
  id text primary key,                            -- 'file_' + 10 lowercase alphanumerics
  created_at timestamptz not null default now(),
  origin text not null,                           -- 'upload' | 'created'
  internal boolean not null default false,        -- never shown or usable through tools (e.g. sandbox preview bundles)
  thread_id text not null,                        -- where it was uploaded / created (no FK: retention handles files)
  channel_id text not null,
  owner_id text,                                  -- uploader, or the speaker the bot made it for (null: other bots)
  created_turn_id bigint,                         -- created by a front turn …
  created_run_id bigint,                          -- … or by a subagent run
  created_subagent_id text,
  idem_key text unique,                           -- created files: same key → same file (retried side effects)
  slack_file_id text,                             -- uploads
  slack_url text,                                 -- uploads: url_private (bot-token download)
  message_ts text,                                -- uploads: the Slack message carrying it (deletion)
  name text not null,
  mime text,
  size bigint,
  description text,                               -- one line, ≤ ~200 chars, untrusted
  description_source text,                        -- 'creator' | 'model'
  content bytea,                                  -- null until fetched (uploads)
  sha256 text,
  legacy_image_n int,                             -- migrated thread_images: the old img_N keeps resolving in its thread
  constraint files_origin_check check (origin in ('upload', 'created')),
  constraint files_id_check check (id ~ '^file_[a-z0-9]{10}$')
);
create unique index if not exists files_thread_slack_idx on files (thread_id, slack_file_id) where slack_file_id is not null;
create index if not exists files_message_idx on files (channel_id, message_ts) where message_ts is not null;
create index if not exists files_run_idx on files (created_run_id) where created_run_id is not null;
create index if not exists files_thread_legacy_idx on files (thread_id, legacy_image_n) where legacy_image_n is not null;
create index if not exists files_created_idx on files (created_at);

-- Store files the bot posted to Slack (reply / send_message): the Slack copy maps back to the same file id in context,
-- and the file is usable in the thread it was posted to.
create table if not exists file_posts (
  slack_file_id text primary key,
  file_id text not null references files(id) on delete cascade,
  channel_id text not null,
  thread_id text not null,
  posted_at timestamptz not null default now()
);
create index if not exists file_posts_file_idx on file_posts (file_id);

-- BEGIN thread_images → files
-- Per-thread image ids (img_N, migration 001) become upload rows; `legacy_image_n` keeps `img_N` resolving in its
-- thread (old subagent histories, run instructions).
do $$
declare
  r record;
  tries int;
begin
  if to_regclass('thread_images') is null then
    return;
  end if;
  for r in
    select ti.thread_id, ti.n, ti.file_id, ti.name, ti.mimetype, ti.url_private, ti.from_user, ti.message_ts,
           split_part(ti.thread_id, ':', 1) as channel_id
    from thread_images ti order by ti.thread_id, ti.n
  loop
    tries := 0;
    loop
      begin
        insert into files (id, origin, thread_id, channel_id, owner_id, slack_file_id, slack_url, message_ts, name, mime, legacy_image_n)
        values ('file_' || substr(md5(random()::text || clock_timestamp()::text || r.file_id), 1, 10), 'upload', r.thread_id,
                r.channel_id, r.from_user, r.file_id, r.url_private, r.message_ts, coalesce(nullif(r.name, ''), 'image'),
                r.mimetype, r.n)
        on conflict (thread_id, slack_file_id) where slack_file_id is not null
          do update set legacy_image_n = coalesce(files.legacy_image_n, excluded.legacy_image_n);
        exit;
      exception when unique_violation then
        -- id collision: draw again
        tries := tries + 1;
        if tries > 5 then
          raise;
        end if;
      end;
    end loop;
  end loop;
  drop table thread_images;
end $$;
-- END thread_images → files

alter table threads drop column if exists next_image_n;
