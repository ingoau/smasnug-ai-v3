-- Multi-round workflows: a card started from a synthesis turn points at the card whose results led to it, so later
-- synthesis turns can see the earlier rounds' results.
alter table cards add column parent_card_id bigint references cards(id) on delete set null;
