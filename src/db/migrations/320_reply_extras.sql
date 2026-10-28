-- Every extra block on a bot reply (charts, inline images, data tables, cards; src/agent/rich-blocks.ts) as JSON text
-- (text, not jsonb: the camelCase transform would rename the block keys on read). `charts` stays for older rows.
alter table reply_charts add column extras text;
