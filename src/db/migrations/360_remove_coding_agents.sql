-- Coding agents (Cursor Cloud Agents; 160_cursor_agents.sql, 170_schedule_cursor_fixes.sql) were removed.
-- Close any leftover ones (their Cursor-side agents, if still running, must be stopped in Cursor's dashboard), then
-- drop their tables and columns. subagents.kind only ever held 'model' / 'cursor', so it goes too.
update runs set status = 'cancelled', cancel_requested = true, finished_at = coalesce(finished_at, now())
  where status in ('queued', 'running') and subagent_id in (select id from subagents where kind = 'cursor');
update subagents set status = 'cancelled' where kind = 'cursor' and status in ('running', 'idle');
-- Outcome turns of coding-agent launch previews that haven't run yet: nothing left to report.
update turns set status = 'cancelled', finished_at = now()
  where status = 'pending' and id in (select turn_id from scheduled_turn_inputs where source = 'coding_launch');

drop table if exists cursor_runs;
drop table if exists pending_coding_agents;
alter table subagents drop column if exists cursor_agent_id;
alter table subagents drop column if exists cursor_agent_url;
alter table subagents drop column if exists kind;
