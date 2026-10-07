-- Sandboxes: when the row last changed (any update). The orphan reconcile leaves a provider sandbox alone while its
-- row changed recently (a transition that just finished, e.g. pausing → paused while the provider still lists it).
alter table sandboxes add column if not exists updated_at timestamptz not null default now();

create or replace function sandboxes_touch_updated_at() returns trigger language plpgsql as $$
begin
  -- An explicit updated_at in the update wins (tests backdate rows); otherwise now().
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists sandboxes_touch_updated_at on sandboxes;
create trigger sandboxes_touch_updated_at before update on sandboxes
  for each row execute function sandboxes_touch_updated_at();
