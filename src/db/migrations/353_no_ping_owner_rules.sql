-- 1. An explicit "don't @mention me" marker on a preference fact, set by the model (remember tool / extraction), so the
--    <rules> no-ping list (src/features/memory/rules.ts) no longer guesses from the fact's wording.
alter table user_memory add column if not exists no_ping boolean not null default false;
create index if not exists user_memory_no_ping_idx on user_memory (user_id) where no_ping;
-- Existing facts: only the unambiguous wordings ("doesn't want to be pinged", "don't @mention me", "without pinging
-- them"), never "don't hesitate to ping me" or "prefers not to use git tags".
update user_memory set no_ping = true
where kind = 'preference' and not no_ping
  and text ~* '\m(not|never|no|don''?t|doesn''?t|stop|without|avoid)\M'
  and text !~* 'hesitat'
  and (text ~* '\m(be|being|get|getting)\s+(@|at-?)?(pinged|mentioned|tagged)\M'
    or text ~* '\m(ping|pinging|@?mention|@?mentioning|tag|tagging)\s+(me|them|him|her)\M');

-- 2. A channel rule saved right away for the channel's creator (not the admin): rendered as the owner's preference,
--    not a workspace rule, and reported to the moderation channel.
alter table workspace_facts add column if not exists set_by_owner boolean not null default false;
