-- Quick-reply buttons that don't start a model turn (src/agent/reply-quiet.ts): per button (same order as labels),
-- null = a press starts a turn, {"kind":"none"} = only the "pressed" note, {"kind":"text","text":…} = plus a fixed
-- reply posted by code. Null column (older rows, or no such button) = every button starts a turn.
alter table reply_buttons add column if not exists responses jsonb;
