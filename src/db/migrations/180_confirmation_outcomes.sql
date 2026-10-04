-- Confirmation outcomes (src/features/outcome-turn.ts): resolving a send_message preview (Send / Cancel / expiry) or a
-- coding-agent launch preview (Cancel / failure / expiry) starts a 'scheduled' front turn whose input states the
-- outcome. Those sources are keyed by a uuid (the pending row), not a bigint id.
alter table scheduled_turn_inputs alter column source_id drop not null;
alter table scheduled_turn_inputs add column source_ref text;   -- send | coding_launch: the pending row's id
-- At most one outcome turn per pending confirmation (the status transition already guarantees it; this is the backstop).
create unique index scheduled_turn_inputs_source_ref_idx on scheduled_turn_inputs (source, source_ref) where source_ref is not null;
