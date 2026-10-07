/**
 * Sandbox spend (docs/sandbox.md §4.3): free tiers only, hard stop.
 *
 * - Every live segment of a sandbox (create/resume → pause/destroy, and each preview-deploy sandbox) is a
 *   `sandbox_usage` row; its cost is seconds × (cpu-limit × core rate + memory-limit × GiB rate), an upper bound
 *   because Modal bills max(reservation, usage) and we reserve less than the limits.
 * - The month's spend is max(our estimate, Modal's metered cost for this environment) when Modal answers (raw
 *   billing API, refreshed by the `sandbox:budget` task). A second backstop compares Modal's whole-workspace cost
 *   (dev + prod share the $30 credit) with SANDBOX_WORKSPACE_CREDIT_USD.
 * - A start (create, resume, deploy) needs room for one maximum segment (`reserve`). At 100 % the sweep pauses
 *   every running sandbox and new ones are refused until the next calendar month (UTC); at 80 % the mod channel
 *   gets one notice.
 */
import { env, limits, sandboxPricing } from '../config.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';

// ---------- pure ----------

export function segmentUsd(cpu: number, memoryMiB: number, seconds: number): number {
  const hours = Math.max(0, seconds) / 3600;
  return hours * (cpu * sandboxPricing.cpuCoreHourUsd + (memoryMiB / 1024) * sandboxPricing.memGibHourUsd);
}

/** The most one live segment can cost (it is killed at its lifetime). */
export function reserveUsd(): number {
  return segmentUsd(limits.sandboxCpuLimit, limits.sandboxMemoryLimitMiB, limits.sandboxLifetimeMs / 1000);
}

export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const nextMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
export const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export interface BudgetInput {
  estUsd: number;
  modalEnvUsd: number | null;
  modalWorkspaceUsd: number | null;
  budgetUsd: number;
  workspaceCreditUsd: number;
  reserveUsd: number;
}

export interface BudgetEval {
  /** What counts as spent: max(estimate, Modal's metered cost for this environment). */
  spentUsd: number;
  exhausted: boolean;
  /** Room for one more maximum segment. */
  canStart: boolean;
  /** ≥ 80 % of the budget (or of the workspace credit). */
  warn: boolean;
}

export function evaluateBudget(i: BudgetInput): BudgetEval {
  const spentUsd = Math.max(i.estUsd, i.modalEnvUsd ?? 0);
  const ws = i.modalWorkspaceUsd;
  const exhausted = spentUsd >= i.budgetUsd || (ws != null && ws >= i.workspaceCreditUsd);
  const canStart = !exhausted && spentUsd + i.reserveUsd <= i.budgetUsd && (ws == null || ws + i.reserveUsd <= i.workspaceCreditUsd);
  const warn = spentUsd >= 0.8 * i.budgetUsd || (ws != null && ws >= 0.8 * i.workspaceCreditUsd);
  return { spentUsd, exhausted, canStart, warn };
}

/** Pure: a user's daily live minutes left (negative = over). */
export function minutesLeft(usedMinutes: number, cap = limits.userSandboxMinutesPerDay): number {
  return cap - usedMinutes;
}

// ---------- segments ----------

export async function openSegment(o: { sandboxId?: string; previewId?: string; userId: string; threadId: string; cpu: number; memoryMiB: number }): Promise<number> {
  const [r] = await sql<{ id: number }[]>`
    insert into sandbox_usage (sandbox_id, preview_id, user_id, thread_id, cpu, memory_mib)
    values (${o.sandboxId ?? null}, ${o.previewId ?? null}, ${o.userId}, ${o.threadId}, ${o.cpu}, ${o.memoryMiB}) returning id`;
  return Number(r!.id);
}

/** Close the open segments of a sandbox (or one segment by id). Idempotent. */
export async function closeSegments(where: { sandboxId: string } | { id: number }): Promise<void> {
  const cond = 'sandboxId' in where ? sql`sandbox_id = ${where.sandboxId}` : sql`id = ${where.id}`;
  await sql`
    update sandbox_usage set ended_at = now(),
      est_usd = extract(epoch from (now() - started_at)) / 3600.0 * (cpu * ${sandboxPricing.cpuCoreHourUsd} + memory_mib / 1024.0 * ${sandboxPricing.memGibHourUsd})
    where ended_at is null and ${cond}`;
}

/** This month's estimate: closed segments + open ones accrued until now (by start month). */
export async function monthEstimateUsd(now = new Date()): Promise<number> {
  const [r] = await sql<{ usd: number | null }[]>`
    select sum(coalesce(est_usd,
      extract(epoch from (now() - started_at)) / 3600.0 * (cpu * ${sandboxPricing.cpuCoreHourUsd} + memory_mib / 1024.0 * ${sandboxPricing.memGibHourUsd})))::float8 as usd
    from sandbox_usage where started_at >= ${monthStart(now)}`;
  return Number(r?.usd ?? 0);
}

/** A user's live sandbox minutes today (UTC), open segments included. */
export async function userMinutesToday(userId: string, now = new Date()): Promise<number> {
  const [r] = await sql<{ s: number | null }[]>`
    select sum(extract(epoch from (coalesce(ended_at, now()) - greatest(started_at, ${dayStart(now)}))))::float8 as s
    from sandbox_usage where user_id = ${userId} and sandbox_id is not null and coalesce(ended_at, now()) > ${dayStart(now)}`;
  return Number(r?.s ?? 0) / 60;
}

// ---------- status ----------

export interface BudgetStatus extends BudgetEval {
  estUsd: number;
  modalEnvUsd: number | null;
  modalWorkspaceUsd: number | null;
  budgetUsd: number;
  month: Date;
}

let cache: { at: number; value: Promise<BudgetStatus> } | undefined;
const CACHE_MS = 5000;

async function loadStatus(): Promise<BudgetStatus> {
  const now = new Date();
  const month = monthStart(now);
  const [estUsd, [row]] = await Promise.all([
    monthEstimateUsd(now),
    sql<{ modalEnvUsd: string | null; modalWorkspaceUsd: string | null }[]>`select modal_env_usd, modal_workspace_usd from sandbox_spend_monthly where month = ${month}`,
  ]);
  const modalEnvUsd = row?.modalEnvUsd != null ? Number(row.modalEnvUsd) : null;
  const modalWorkspaceUsd = row?.modalWorkspaceUsd != null ? Number(row.modalWorkspaceUsd) : null;
  const e = evaluateBudget({ estUsd, modalEnvUsd, modalWorkspaceUsd, budgetUsd: env.SANDBOX_MONTHLY_BUDGET_USD, workspaceCreditUsd: env.SANDBOX_WORKSPACE_CREDIT_USD, reserveUsd: reserveUsd() });
  return { ...e, estUsd, modalEnvUsd, modalWorkspaceUsd, budgetUsd: env.SANDBOX_MONTHLY_BUDGET_USD, month };
}

export function budgetStatus(): Promise<BudgetStatus> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const value = loadStatus();
    cache = { at: Date.now(), value };
    value.catch(() => (cache = undefined));
  }
  return cache.value;
}

export function invalidateBudget() {
  cache = undefined;
}

/**
 * `sandbox:budget` task: refresh Modal's metered numbers, store the month row, send the 80 % notice once. Returns
 * the status (the sweep pauses everything when it's exhausted).
 */
export async function refreshBudget(o: {
  metered?: () => Promise<{ environmentUsd: number | null; workspaceUsd: number | null }>;
  notify?: (text: string) => Promise<void>;
}): Promise<BudgetStatus> {
  const now = new Date();
  const month = monthStart(now);
  let m: { environmentUsd: number | null; workspaceUsd: number | null } = { environmentUsd: null, workspaceUsd: null };
  if (o.metered) m = await o.metered().catch((err) => (log.warn({ err }, 'metered spend failed'), m));
  const est = await monthEstimateUsd(now);
  await sql`
    insert into sandbox_spend_monthly (month, est_usd, modal_env_usd, modal_workspace_usd, updated_at)
    values (${month}, ${est}, ${m.environmentUsd}, ${m.workspaceUsd}, now())
    on conflict (month) do update set est_usd = excluded.est_usd,
      modal_env_usd = coalesce(excluded.modal_env_usd, sandbox_spend_monthly.modal_env_usd),
      modal_workspace_usd = coalesce(excluded.modal_workspace_usd, sandbox_spend_monthly.modal_workspace_usd),
      updated_at = now()`;
  invalidateBudget();
  const s = await budgetStatus();
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  if (s.warn) {
    const [first] = await sql`update sandbox_spend_monthly set alerted_80 = true where month = ${month} and not alerted_80 returning month`;
    if (first && o.notify)
      await o.notify(`Code sandboxes: ${fmt(s.spentUsd)} of this month's ${fmt(s.budgetUsd)} budget used${s.modalWorkspaceUsd != null ? ` (Modal workspace total ${fmt(s.modalWorkspaceUsd)})` : ''}. The feature stops at 100 % until next month.`);
  }
  if (s.exhausted) {
    const [first] = await sql`update sandbox_spend_monthly set stopped = true where month = ${month} and not stopped returning month`;
    if (first && o.notify) await o.notify(`Code sandboxes are stopped until next month: ${fmt(s.spentUsd)} of ${fmt(s.budgetUsd)} used. Running sandboxes are being paused.`);
  }
  return s;
}
