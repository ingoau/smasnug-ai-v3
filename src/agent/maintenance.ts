/** Reliability tasks: stale-run sweeper and idle-subagent expiry. */
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { failRuns, maybeSynthesize } from './subagents.js';

/** Runs whose worker stopped heartbeating → error "Worker stopped" (card re-render + synthesis if last). */
export async function sweepStaleRuns(): Promise<number> {
  const stale = await sql<{ id: number }[]>`
    select id from runs where status = 'running'
      and coalesce(heartbeat_at, started_at, created_at) < now() - ${limits.staleHeartbeatMs / 1000} * interval '1 second'`;
  // Queued runs whose job never started (e.g. lost enqueue) are failed after the max run duration.
  const lost = await sql<{ id: number }[]>`
    select id from runs where status = 'queued' and created_at < now() - ${limits.runMaxDurationMs / 1000} * interval '1 second'`;
  if (stale.length) await failRuns({ runIds: stale.map((r) => Number(r.id)) }, 'Worker stopped');
  if (lost.length) await failRuns({ runIds: lost.map((r) => Number(r.id)) }, 'Never started');
  // Safety net: cards whose runs are all terminal but whose synthesis was never requested (e.g. requestTurn failed).
  const orphaned = await sql<{ id: number }[]>`
    select c.id from cards c where not c.synthesized and c.created_at > now() - interval '1 day'
      and exists (select 1 from runs r where r.card_id = c.id)
      and not exists (select 1 from runs r where r.card_id = c.id and r.status in ('queued', 'running'))`;
  for (const c of orphaned) await maybeSynthesize(Number(c.id));
  const n = stale.length + lost.length;
  if (n) log.info({ stale: stale.length, lost: lost.length }, 'swept runs');
  return n;
}

/** Idle subagents older than ~24h expire and drop out of the snapshot. */
export async function expireIdleSubagents(): Promise<number> {
  const rows = await sql`
    update subagents set status = 'expired'
    where status = 'idle' and last_active_at < now() - ${limits.subagentIdleExpiryMs / 1000} * interval '1 second'
    returning id`;
  return rows.length;
}
