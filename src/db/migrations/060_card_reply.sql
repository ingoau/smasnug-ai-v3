-- A plan card lives in the reply message of the turn that started its runs: message_ts is then that reply's ts and
-- reply_text its text (re-rendered on every card update). NULL reply_text = a standalone card message.
alter table cards add column if not exists reply_text text;
