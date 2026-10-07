-- When the bot responds (design doc, "When the bot responds"; src/pipeline/rules.ts).
-- The bot's latest reply in a thread: any reply (also synthesis / scheduled turns) counts as activity for the idle
-- clock, names the person it was talking with (that turn's speaker), and whether it ended with a question, an offer
-- or quick-reply buttons (then that person's next message runs without the gate).
alter table threads add column last_bot_reply_at timestamptz;
alter table threads add column last_bot_reply_ts text;
alter table threads add column last_bot_partner text;
alter table threads add column awaits_reply_from text;

-- Turns framed as "talking with you" (no @mention needed): answers to the bot's question / offer, and two-party or
-- conversation-partner follow-ups that passed the gate.
alter table turns add column addressed boolean not null default false;

-- The intake reason (rules.ts BatchReason) of a message pushed into a running turn's inbox: leftovers the turn never
-- drained go through the gate when they needed it, instead of running unconditionally.
alter table thread_inbox add column reason text;
