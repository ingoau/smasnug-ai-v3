-- Which button of a reply_buttons row was pressed (labels can repeat, so pressed_label alone can't tell). Null on
-- older rows: found by its label.
alter table reply_buttons add column if not exists pressed_index int;
