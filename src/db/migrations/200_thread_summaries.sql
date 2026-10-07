-- Rolling summary of a thread's replies that are older than the history window shown in the front agent's prompt
-- (src/context/summary.ts). Updated incrementally by the thread-summary queue: previous summary + newly dropped
-- replies -> new summary. It goes with the thread (cascade), when the stored copy of the oldest message folded into it
-- passes the retention window (it is then rebuilt from what is still stored), and when a reply it covers is deleted
-- in Slack (src/features/retention.ts).
create table thread_summaries (
  thread_id text primary key references threads(id) on delete cascade,
  summary text not null,
  covered_ts text not null,                     -- newest reply ts the summary covers (every reply at or before it)
  covered_count int not null default 0,         -- replies folded in so far
  updates int not null default 0,               -- model calls that produced it
  model text,
  input_tokens bigint not null default 0,       -- cumulative usage of those calls
  output_tokens bigint not null default 0,
  oldest_message_at timestamptz not null,       -- min(messages.created_at) of the replies folded in (retention)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
