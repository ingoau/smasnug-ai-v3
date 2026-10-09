-- Charts on a bot reply (Slack data_visualization blocks, src/agent/charts.ts). Re-renders of that message
-- (plan card, button press) rebuild blocks from DB state, so the charts live here or the next chat.update drops them.
create table reply_charts (
  channel_id text not null,
  message_ts text not null,
  charts jsonb not null,
  primary key (channel_id, message_ts)
);
