/**
 * Sandbox lifecycle (docs/sandbox.md §3.5). One sandbox per subagent, created lazily by its first sandbox tool call,
 * reused while live, paused (filesystem snapshot + terminate) when idle, resumed on the next use, destroyed when the
 * subagent ends. Nothing lives in worker memory: the `sandboxes` row is the state, a Redis lock per subagent
 * serialises transitions, and stale jobs are no-ops (the generation counter).
 *
 * States: creating → running → pausing → paused → resuming → running; destroying → destroyed; lost (the provider no
 * longer has it, e.g. killed at its lifetime: the next use creates a fresh one and the tool says files were lost).
 */
import { env, limits } from '../config.js';
import { shortId } from '../core/events.js';
import { enqueue, QUEUE } from '../core/queues.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { acquireLock, type HeldLock } from '../pipeline/lock.js';
import { budgetStatus, closeSegments, openSegment, userMinutesToday } from './budget.js';
import { egressAllowlist } from './egress.js';
import { workImage } from './image.js';
import { SandboxGoneError, type Handle, type Paused, type SandboxSpec } from './provider.js';
import { baseTags, sandboxProvider } from './providers.js';
import { sandboxSettings } from './settings.js';

export type SandboxState = 'creating' | 'running' | 'pausing' | 'paused' | 'resuming' | 'destroying' | 'destroyed' | 'lost';

export interface SandboxRow {
  id: string;
  subagentId: string | null;
  threadId: string;
  ownerId: string;
  provider: string;
  providerId: string | null;
  pausedRef: string | null;
  pausedExpiresAt: Date | null;
  image: string;
  cpu: number;
  memoryMib: number;
  state: SandboxState;
  generation: number;
  idleSince: Date | null;
  liveSince: Date | null;
  lastUsedAt: Date;
}

/** A refusal the model may see (quotas, budget): plain, non-personal text. */
export class SandboxRefused extends Error {}

const LOCK_TTL_MS = 3 * 60_000;
const LOCK_WAIT_MS = 3 * 60_000;

async function lockFor(key: string): Promise<HeldLock> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const l = await acquireLock(`lock:sandbox:${key}`, LOCK_TTL_MS);
    if (l) return l;
    if (Date.now() > deadline) throw new Error('sandbox is busy (lock wait timed out)');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const l = await lockFor(key);
  try {
    return await fn();
  } finally {
    await l.release();
  }
}

const lockKey = (row: Pick<SandboxRow, 'id' | 'subagentId'>) => row.subagentId ?? row.id;

export function workSpec(sandboxId: string): SandboxSpec {
  return {
    image: { kind: 'work' },
    cpu: limits.sandboxCpu,
    cpuLimit: limits.sandboxCpuLimit,
    memoryMiB: limits.sandboxMemoryMiB,
    memoryLimitMiB: limits.sandboxMemoryLimitMiB,
    lifetimeMs: limits.sandboxLifetimeMs,
    egress: { allowCidrs: egressAllowlist({ ipv6: false, extraDeny: (env.SANDBOX_EGRESS_DENY ?? '').split(',') }) },
    // No user ids in provider tags (privacy): the row links the sandbox to its owner.
    tags: { ...baseTags(), kind: 'work', sbx: sandboxId },
  };
}

export async function sandboxRowForSubagent(subagentId: string): Promise<SandboxRow | null> {
  const [r] = await sql<SandboxRow[]>`select * from sandboxes where subagent_id = ${subagentId}`;
  return r ?? null;
}

/** Pure: the quota refusal for starting (creating or resuming) a live sandbox, or null. */
export function startRefusal(o: { canStart: boolean; userLive: number; globalLive: number; userMinutes: number }): string | null {
  if (!o.canStart) return "Code sandboxes are paused until next month: this month's free compute is used up. Tell the user plainly.";
  if (o.userLive >= limits.userLiveSandboxes)
    return `Limit reached: this user already has ${o.userLive} live sandboxes (max ${limits.userLiveSandboxes}). Wait until another subagent's sandbox is idle, then retry.`;
  if (o.globalLive >= limits.globalLiveSandboxes) return 'All code sandboxes are busy right now. Try again in a few minutes.';
  if (o.userMinutes >= limits.userSandboxMinutesPerDay)
    return `Limit reached: this user has used today's ${limits.userSandboxMinutesPerDay} sandbox minutes. It resets at 00:00 UTC. Tell the user briefly.`;
  return null;
}

async function checkStart(ownerId: string): Promise<void> {
  const [budget, [counts], minutes] = await Promise.all([
    budgetStatus(),
    sql<{ user: number; global: number }[]>`
      select count(*) filter (where owner_id = ${ownerId})::int as user, count(*)::int as global
      from sandboxes where state in ('creating', 'running', 'resuming')`,
    userMinutesToday(ownerId),
  ]);
  const refusal = startRefusal({ canStart: budget.canStart, userLive: counts?.user ?? 0, globalLive: counts?.global ?? 0, userMinutes: minutes });
  if (refusal) throw new SandboxRefused(refusal);
}

export interface Ensured {
  sandboxId: string;
  handle: Handle;
  /** Something the model should know (e.g. its files were lost). */
  note?: string;
}

/**
 * The subagent's live sandbox: reuse, resume or create (lazily, so a subagent that never runs code costs nothing).
 * Parallel tool calls in one step get the same sandbox (per-subagent lock).
 */
export async function ensureSandbox(o: { subagentId: string; threadId: string; ownerId: string }): Promise<Ensured> {
  return withLock(o.subagentId, async () => {
    const row = await sandboxRowForSubagent(o.subagentId);
    if (row?.state === 'running' && row.providerId) {
      await sql`update sandboxes set last_used_at = now(), idle_since = null where id = ${row.id}`;
      return { sandboxId: row.id, handle: { providerId: row.providerId } };
    }
    await checkStart(o.ownerId);
    const provider = sandboxProvider();
    const id = row?.id ?? shortId('sbx');
    const spec = workSpec(id);
    let note: string | undefined;
    let handle: Handle;
    if (!row) {
      await sql`
        insert into sandboxes (id, subagent_id, thread_id, owner_id, provider, image, cpu, memory_mib, state, generation)
        values (${id}, ${o.subagentId}, ${o.threadId}, ${o.ownerId}, ${provider.name}, ${workImage().name}, ${limits.sandboxCpuLimit}, ${limits.sandboxMemoryLimitMiB}, 'creating', 1)`;
    } else {
      await sql`update sandboxes set state = ${row.state === 'paused' ? 'resuming' : 'creating'}, generation = generation + 1, provider = ${provider.name}, last_used_at = now() where id = ${id}`;
    }
    try {
      if (row?.state === 'paused' && row.pausedRef) {
        const paused: Paused = { kind: 'fs-snapshot', ref: row.pausedRef, expiresAt: row.pausedExpiresAt };
        try {
          handle = await provider.resume(paused, spec);
          // The new sandbox has the files; the next pause takes a fresh snapshot.
          if (provider.deletePaused) void provider.deletePaused(paused).catch((err) => log.debug({ err, sandboxId: id }, 'old snapshot delete failed (it expires on its own)'));
        } catch (err) {
          log.warn({ err, sandboxId: id }, 'sandbox resume failed; creating a fresh one');
          handle = await provider.create(spec);
          note = 'Your previous sandbox could not be restored, so this is a fresh one: files from before are gone.';
          if (provider.deletePaused) void provider.deletePaused(paused).catch(() => {});
        }
      } else {
        handle = await provider.create(spec);
        if (row && row.state === 'lost') note = 'Your previous sandbox stopped (it hit its time limit or crashed), so this is a fresh one: files from before are gone.';
        else if (row && row.state !== 'creating') note = 'This is a fresh sandbox: files from before are gone.';
      }
    } catch (err) {
      await sql`update sandboxes set state = 'lost', provider_id = null where id = ${id}`;
      throw err;
    }
    await sql`
      update sandboxes set state = 'running', provider_id = ${handle.providerId}, paused_ref = null, paused_expires_at = null,
        live_since = now(), idle_since = null, last_used_at = now()
      where id = ${id}`;
    await openSegment({ sandboxId: id, userId: o.ownerId, threadId: o.threadId, cpu: limits.sandboxCpuLimit, memoryMiB: limits.sandboxMemoryLimitMiB });
    return { sandboxId: id, handle, note };
  });
}

/** The provider lost the sandbox (lifetime kill, crash): the next use creates a fresh one. */
export async function markLost(sandboxId: string, providerId?: string): Promise<void> {
  await sql`update sandboxes set state = 'lost', provider_id = null
            where id = ${sandboxId} and state = 'running' ${providerId ? sql`and provider_id = ${providerId}` : sql``}`;
  await closeSegments({ sandboxId });
}

/**
 * Run `fn` against the subagent's sandbox. When the provider says it is gone, the row is marked lost and `fn` runs
 * once more on a fresh sandbox (the note tells the model its files were lost).
 */
export async function withSandbox<T>(o: { subagentId: string; threadId: string; ownerId: string }, fn: (h: Handle) => Promise<T>): Promise<{ value: T; note?: string }> {
  const first = await ensureSandbox(o);
  try {
    return { value: await fn(first.handle), note: first.note };
  } catch (err) {
    if (!(err instanceof SandboxGoneError)) throw err;
    await markLost(first.sandboxId, first.handle.providerId);
    const again = await ensureSandbox(o);
    const note = again.note ?? 'Your sandbox stopped (time limit), so this ran in a fresh one: files from before are gone.';
    return { value: await fn(again.handle), note };
  }
}

/** Pause job: snapshot + terminate, unless the sandbox was used again meanwhile (generation) or a run is active. */
export async function pauseSandbox(sandboxId: string, o: { generation?: number; force?: boolean } = {}): Promise<'paused' | 'skipped' | 'lost'> {
  const [pre] = await sql<SandboxRow[]>`select * from sandboxes where id = ${sandboxId}`;
  if (!pre) return 'skipped';
  return withLock(lockKey(pre), async () => {
    const [row] = await sql<SandboxRow[]>`select * from sandboxes where id = ${sandboxId}`;
    if (!row || row.state !== 'running' || !row.providerId) return 'skipped';
    if (o.generation != null && row.generation !== o.generation) return 'skipped';
    if (!o.force && row.subagentId) {
      const [active] = await sql`select 1 from runs where subagent_id = ${row.subagentId} and status in ('queued', 'running') limit 1`;
      if (active) return 'skipped';
    }
    await sql`update sandboxes set state = 'pausing', last_used_at = now() where id = ${row.id}`;
    const provider = sandboxProvider();
    try {
      const paused = await provider.pause({ providerId: row.providerId });
      await sql`update sandboxes set state = 'paused', provider_id = null, paused_ref = ${paused.ref}, paused_expires_at = ${paused.expiresAt}, idle_since = null
                where id = ${row.id}`;
      await closeSegments({ sandboxId: row.id });
      return 'paused';
    } catch (err) {
      if (!(err instanceof SandboxGoneError)) log.warn({ err, sandboxId: row.id }, 'sandbox pause failed; terminating it');
      await provider.destroy({ providerId: row.providerId }).catch(() => {});
      await sql`update sandboxes set state = 'lost', provider_id = null where id = ${row.id}`;
      await closeSegments({ sandboxId: row.id });
      return 'lost';
    }
  });
}

/** Destroy job: terminate the live sandbox and delete its snapshot. Idempotent. */
export async function destroySandbox(sandboxId: string): Promise<void> {
  const [pre] = await sql<SandboxRow[]>`select * from sandboxes where id = ${sandboxId}`;
  if (!pre || pre.state === 'destroyed') return;
  await withLock(lockKey(pre), async () => {
    const [row] = await sql<SandboxRow[]>`select * from sandboxes where id = ${sandboxId}`;
    if (!row || row.state === 'destroyed') return;
    await sql`update sandboxes set state = 'destroying', last_used_at = now() where id = ${row.id}`;
    const provider = sandboxProvider();
    if (row.providerId) await provider.destroy({ providerId: row.providerId });
    if (row.pausedRef && provider.deletePaused) await provider.deletePaused({ kind: 'fs-snapshot', ref: row.pausedRef, expiresAt: row.pausedExpiresAt }).catch((err) => log.warn({ err, sandboxId }, 'snapshot delete failed (it expires on its own)'));
    await sql`update sandboxes set state = 'destroyed', provider_id = null, paused_ref = null, ended_at = now() where id = ${row.id}`;
    await closeSegments({ sandboxId: row.id });
  });
}

// The job ids dedupe while a job is pending only (removed when done): a pause that was skipped (a run was active) or a
// destroy that failed must be enqueueable again by the next sweep.
export const enqueuePause = (row: Pick<SandboxRow, 'id' | 'generation'>, force = false) =>
  enqueue(QUEUE.sandbox, { type: 'pause', sandboxId: row.id, generation: row.generation, force }, { jobId: `pause-${row.id}-${row.generation}`, attempts: 2, backoff: { type: 'fixed', delay: 10_000 }, removeOnComplete: true, removeOnFail: true });
export const enqueueDestroy = (id: string) =>
  enqueue(QUEUE.sandbox, { type: 'destroy', sandboxId: id }, { jobId: `destroy-${id}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: true });

/**
 * `sandbox:sweep` (every 30 s): idle → pause; feature off or budget exhausted → pause everything (snapshot first, so
 * work isn't lost); subagent ended (expired, cancelled, deleted with its thread) → destroy; expired snapshots → lost.
 */
export async function sweepSandboxes(): Promise<{ paused: number; destroyed: number }> {
  const [settings, budget] = await Promise.all([sandboxSettings(), budgetStatus()]);
  const stopAll = settings.disabled || budget.exhausted;
  const idleBefore = new Date(Date.now() - limits.sandboxIdlePauseMs);
  const toPause = stopAll
    ? await sql<SandboxRow[]>`select id, generation from sandboxes where state = 'running'`
    : await sql<SandboxRow[]>`
        select x.id, x.generation from sandboxes x
        where x.state = 'running' and coalesce(x.idle_since, x.last_used_at) < ${idleBefore}
          and not exists (select 1 from runs r where r.subagent_id = x.subagent_id and r.status in ('queued', 'running'))`;
  for (const r of toPause) await enqueuePause(r, stopAll);
  const dead = await sql<{ id: string }[]>`
    select x.id from sandboxes x left join subagents s on s.id = x.subagent_id
    where x.state not in ('destroyed', 'destroying', 'creating', 'resuming', 'pausing')
      and (x.subagent_id is null or s.status in ('cancelled', 'expired'))`;
  for (const r of dead) await enqueueDestroy(r.id);
  await sql`update sandboxes set state = 'lost', paused_ref = null where state = 'paused' and paused_expires_at < now()`;
  return { paused: toPause.length, destroyed: dead.length };
}

/**
 * `sandbox:reconcile` (every 10 min): provider sandboxes without a live row are orphans (worker crash mid-create,
 * a failed destroy) → terminated; live rows the provider no longer has → lost; transitions stuck for long → lost.
 */
export async function reconcileSandboxes(): Promise<{ orphans: number; lost: number }> {
  const provider = sandboxProvider();
  const live = await provider.list(baseTags());
  const rows = await sql<SandboxRow[]>`select * from sandboxes where state in ('creating', 'running', 'resuming', 'pausing', 'destroying')`;
  const byProvider = new Map(rows.filter((r) => r.providerId).map((r) => [r.providerId!, r]));
  const previewsDeploying = new Set(
    (await sql<{ id: string }[]>`select id from previews where status = 'deploying'`).map((r) => r.id),
  );
  let orphans = 0;
  for (const sb of live) {
    if (sb.tags.kind === 'deploy') {
      if (sb.tags.preview && previewsDeploying.has(sb.tags.preview)) continue;
    } else {
      const row = byProvider.get(sb.providerId);
      if (row && row.state === 'running') continue;
      // A create in progress hasn't stored its provider id yet.
      const pending = rows.find((r) => r.id === sb.tags.sbx && (r.state === 'creating' || r.state === 'resuming'));
      if (pending) continue;
    }
    await provider.destroy({ providerId: sb.providerId }).catch((err) => log.warn({ err }, 'orphan destroy failed'));
    orphans++;
  }
  const liveIds = new Set(live.map((l) => l.providerId));
  const minute = Date.now() - 60_000;
  let lost = 0;
  for (const r of rows) {
    if (r.state === 'running' && r.providerId && !liveIds.has(r.providerId) && (r.liveSince?.getTime() ?? 0) < minute) {
      await markLost(r.id, r.providerId);
      lost++;
    } else if (r.state === 'running' && r.liveSince && Date.now() - r.liveSince.getTime() > limits.sandboxLifetimeMs) {
      await markLost(r.id, r.providerId ?? undefined);
      lost++;
    }
  }
  const stuck = await sql`
    update sandboxes set state = 'lost', provider_id = null
    where state in ('creating', 'resuming', 'pausing', 'destroying') and last_used_at < now() - interval '15 minutes'
    returning id`;
  for (const s of stuck) await closeSegments({ sandboxId: s.id });
  return { orphans, lost: lost + stuck.length };
}

/** Retention: ended rows after 30 days, usage segments after 62, stale HCA rows after 30. */
export async function sandboxRetention(): Promise<void> {
  const rows = new Date(Date.now() - limits.sandboxRowRetentionMs);
  await sql`delete from sandboxes where state in ('destroyed', 'lost') and coalesce(ended_at, last_used_at) < ${rows}`;
  await sql`delete from sandbox_usage where started_at < ${new Date(Date.now() - limits.sandboxUsageRetentionMs)}`;
  await sql`delete from hca_verifications where checked_at < ${new Date(Date.now() - limits.hcaRowRetentionMs)}`;
  await sql`delete from previews where status not in ('requested', 'awaiting_terms', 'deploying', 'live') and coalesce(ended_at, created_at) < ${rows}`;
}
