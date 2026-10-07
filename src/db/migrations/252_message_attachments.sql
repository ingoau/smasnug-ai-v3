-- Forwarded messages and link unfurls (Slack `attachments`), normalised (src/context/normalize.ts attachmentsFromSlack),
-- so the thread context shows what Slack showed everyone in the conversation. `##` content is never stored.
alter table messages add column if not exists attachments jsonb not null default '[]';
