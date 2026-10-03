-- URLs a run actually used (fetch_url targets, web-search sources), shown as task_card sources: [{ "url", "title" }].
alter table runs add column if not exists sources jsonb not null default '[]'::jsonb;
