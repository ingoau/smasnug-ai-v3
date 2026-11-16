-- Button types (src/agent/reply-buttons.ts: prompt / text / none / action). `requester_id` = who the reply answered
-- (buttons with who = requester only work for them); `outcome` = what an action button's press did
-- ({"ok":bool,"text":…}), shown in the pressed note and the thread context. Null on older rows.
alter table reply_buttons add column if not exists requester_id text;
alter table reply_buttons add column if not exists outcome jsonb;
