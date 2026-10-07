-- Code sandboxes: the one-time first-use note (where code and files go) was shown to this user.
create table sandbox_first_use (
  user_id text primary key,
  noticed_at timestamptz not null default now()
);
