-- One plan card per bot message: a turn's card also holds its own steps (lookups such as "Searched Slack"), next to
-- the runs it started. [{ "tool": "slack_search", "status": "complete" }, ...] in call order (src/agent/card-steps.ts).
alter table cards add column if not exists steps jsonb not null default '[]';
