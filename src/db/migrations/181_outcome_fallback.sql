-- Outcome turns (src/features/outcome-turn.ts): a code-written message posted in the thread when the turn ends with
-- nothing visible or fails, so a confirmation never depends on the model (e.g. "sent ✓ <link>"). Null: post nothing.
alter table scheduled_turn_inputs add column fallback text;
