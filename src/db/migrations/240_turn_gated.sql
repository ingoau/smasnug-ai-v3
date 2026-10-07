-- User turns that run because the relevance gate said yes (pipeline/fire.ts). They are framed as "a relevance check
-- judged this is meant for you: respond unless it clearly isn't", not as an optional follow-up (front.ts).
alter table turns add column gated boolean not null default false;
