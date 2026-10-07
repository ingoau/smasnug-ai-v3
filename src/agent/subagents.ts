/**
 * Subagent sessions and runs: spawn, message (steer / resume), cancel, run termination and synthesis triggering.
 * A subagent is a persistent session in a thread; each piece of work on it is a run, attached to the plan card of
 * the turn that started it.
 */
import type { ModelMessage } from 'ai';
import type { TransactionSql } from 'postgres';
import { sql } from '../db/index.js';
import type { TurnRow } from '../core/types.js';
import { appendEvent, shortId } from '../core/events.js';
import { enqueue, QUEUE } from '../core/queues.js';
import { takeLimit } from '../features/guard.js';
import { requestTurn } from '../pipeline/scheduler.js';
import { MODELS } from '../models.js';
import { log } from '../log.js';
import { ensureTurnCard, scheduleCardRender } from './cards.js';
import { deriveSteerNote, oneLine } from './util.js';
import { cancelCodingAgentNow, cursorRefusal, isCursorAdmin, messageCodingAgent } from './cursor/agents.js';

export type SubagentStatus = 'running' | 'idle' | 'cancelled' | 'expired';

export interface SubagentRow {
  id: string;
  threadId: string;
  ownerId: string;
  title: string;
  status: SubagentStatus;
  summary: string | null;
  history: ModelMessage[];
  seededFrom: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  /** 'cursor' = a coding agent backed by a Cursor Cloud Agent (src/agent/cursor/). */
  kind?: 'model' | 'cursor';
  cursorAgentId?: string | null;
  cursorAgentUrl?: string | null;
  /** Spawned with `sandbox: true`: gets the sandbox tools and the longer run cap (src/sandbox/). */
  sandbox?: boolean;
}

export interface RunRow {
  id: number;
  subagentId: string;
  threadId: string;
  cardId: number | null;
  turnId: number | null;
  instructions: string;
  isResume: boolean;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  details: string | null;
  steerNotes: string[];
  output: string | null;
  result: string | null;
  error: string | null;
  cancelRequested: boolean;
  reported: boolean;
  tokens: number;
  model: string | null;
  workerId: string | null;
  sources?: { url: string; title?: string }[];
}

/** Thrown from tools as a model-facing error (becomes a tool-error part the model can read). */
export class ToolError extends Error {}

/** Runs queued or running in a thread (drives reply delivery and the thread concurrency limit). */
export async function activeRunsInThread(threadId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from runs where thread_id = ${threadId} and status in ('queued', 'running')`;
  return r?.n ?? 0;
}

/** Per-user and per-thread concurrent-subagent limits (features guard counts active runs; call before creating the run). */
async function checkStartLimits(ownerId: string, threadId: string) {
  const limited = await takeLimit('subagent', ownerId, threadId);
  if (limited) throw new ToolError(limited);
}

async function enqueueRun(runId: number) {
  await enqueue(QUEUE.subagentRun, { runId }, { jobId: `run-${runId}`, attempts: 1 });
}

export async function spawnSubagent(opts: {
  threadId: string;
  turnId: number;
  ownerId: string;
  title: string;
  instructions: string;
  seedFrom?: string;
  /** Code sandbox (src/sandbox/): the caller has checked access; nothing is created until the first sandbox tool call. */
  sandbox?: boolean;
}): Promise<{ subagentId: string; runId: number; cardId: number }> {
  await checkStartLimits(opts.ownerId, opts.threadId);
  let instructions = opts.instructions;
  let seededFrom: string | null = null;
  if (opts.seedFrom) {
    const [old] = await sql<SubagentRow[]>`select * from subagents where id = ${opts.seedFrom} and thread_id = ${opts.threadId}`;
    if (old) {
      seededFrom = old.id;
      if (old.summary) instructions = `Context from an earlier subagent in this thread ("${old.title}"): ${old.summary}\n\n${instructions}`;
    }
  }
  const subagentId = shortId('sa');
  const title = oneLine(opts.title, 80) || 'Subagent';
  const model = MODELS.child;
  const cardId = await ensureTurnCard({ threadId: opts.threadId, turnId: opts.turnId });
  const runId = await sql.begin(async (tx) => {
    await tx`insert into subagents (id, thread_id, owner_id, title, status, seeded_from, sandbox) values (${subagentId}, ${opts.threadId}, ${opts.ownerId}, ${title}, 'running', ${seededFrom}, ${opts.sandbox ?? false})`;
    const [run] = await tx<{ id: number }[]>`
      insert into runs (subagent_id, thread_id, card_id, turn_id, instructions, is_resume, status, model)
      values (${subagentId}, ${opts.threadId}, ${cardId}, ${opts.turnId}, ${instructions}, false, 'queued', ${model}) returning id`;
    return Number(run!.id);
  });
  await enqueueRun(runId);
  await appendEvent(opts.threadId, 'spawn', opts.ownerId, { subagentId, runId, cardId, title, model, instructions: opts.instructions, ...(opts.sandbox ? { sandbox: true } : {}) });
  await scheduleCardRender(cardId);
  return { subagentId, runId, cardId };
}

export type MessageResult =
  | { mode: 'steered'; runId: number; cardId: number | null; note: string; /** coding agents: delivered when the current run ends */ queued?: boolean }
  | { mode: 'resumed'; runId: number; cardId: number };

/**
 * running → push to its inbox (seen at its next step) + steer note on the original card row;
 * idle → new run on the same session (full history), on this turn's card, marked ↻;
 * cancelled / expired → error so the agent spawns a new one.
 */
export async function messageSubagent(opts: {
  threadId: string;
  turnId: number;
  /** Kind of the calling turn: coding agents only take messages from the admin's own ('user') turns. */
  turnKind?: TurnRow['kind'];
  speakerId: string;
  subagentId: string;
  text: string;
  note?: string;
}): Promise<MessageResult> {
  const [pre] = await sql<SubagentRow[]>`select * from subagents where id = ${opts.subagentId} and thread_id = ${opts.threadId}`;
  if (!pre) throw new ToolError(`No subagent ${opts.subagentId} in this thread. Use spawn_subagent to start one.`);
  if (pre.kind === 'cursor') return messageCodingAgent(opts, pre);
  if (pre.status === 'cancelled') throw new ToolError(`Subagent ${pre.id} was cancelled. Spawn a new one with spawn_subagent.`);
  if (pre.status === 'expired')
    throw new ToolError(`Subagent ${pre.id} has expired. Spawn a new one with spawn_subagent and seed_from: "${pre.id}" to carry over its summary.`);
  if (pre.status === 'idle') await checkStartLimits(pre.ownerId, opts.threadId);
  const cardIdForResume = pre.status === 'idle' ? await ensureTurnCard({ threadId: opts.threadId, turnId: opts.turnId }) : null;

  const res = await sql.begin(async (tx): Promise<MessageResult | { error: string }> => {
    const [sa] = await tx<SubagentRow[]>`select * from subagents where id = ${opts.subagentId} for update`;
    if (!sa) return { error: `No subagent ${opts.subagentId}.` };
    if (sa.status === 'running') {
      await tx`insert into subagent_inbox (subagent_id, text) values (${sa.id}, ${opts.text})`;
      const note = oneLine(opts.note || deriveSteerNote(opts.text), 80);
      const [run] = await tx<{ id: number; cardId: number | null }[]>`
        update runs set steer_notes = steer_notes || ${sql.json([note])}::jsonb
        where id = (select id from runs where subagent_id = ${sa.id} and status in ('queued', 'running') order by id desc limit 1)
        returning id, card_id`;
      return { mode: 'steered', runId: Number(run?.id ?? 0), cardId: run?.cardId ? Number(run.cardId) : null, note };
    }
    if (sa.status === 'idle') {
      const [last] = await tx<{ model: string | null }[]>`select model from runs where subagent_id = ${sa.id} order by id desc limit 1`;
      const [run] = await tx<{ id: number }[]>`
        insert into runs (subagent_id, thread_id, card_id, turn_id, instructions, is_resume, status, model)
        values (${sa.id}, ${opts.threadId}, ${cardIdForResume}, ${opts.turnId}, ${opts.text}, true, 'queued', ${last?.model ?? MODELS.child})
        returning id`;
      await tx`update subagents set status = 'running', last_active_at = now() where id = ${sa.id}`;
      return { mode: 'resumed', runId: Number(run!.id), cardId: cardIdForResume! };
    }
    return { error: `Subagent ${sa.id} is ${sa.status}. Spawn a new one with spawn_subagent.` };
  });
  if ('error' in res) throw new ToolError(res.error);
  if (res.mode === 'resumed') {
    await enqueueRun(res.runId);
    await appendEvent(opts.threadId, 'resume', opts.speakerId, { subagentId: opts.subagentId, runId: res.runId, cardId: res.cardId, text: opts.text });
  } else {
    await appendEvent(opts.threadId, 'steer', opts.speakerId, { subagentId: opts.subagentId, runId: res.runId, note: res.note, text: opts.text });
  }
  await scheduleCardRender(res.cardId);
  return res;
}

/** Request cancellation: queued runs are cancelled immediately; running ones stop at their next step boundary. */
export async function cancelSubagent(opts: { threadId: string; subagentId: string; actor: string }): Promise<string> {
  const [kind] = await sql<{ kind: string }[]>`select kind from subagents where id = ${opts.subagentId} and thread_id = ${opts.threadId}`;
  const coding = kind?.kind === 'cursor';
  if (coding) {
    const refusal = cursorRefusal(opts.actor);
    if (refusal) throw new ToolError(refusal);
  }
  const out = await sql.begin(async (tx) => {
    const [sa] = await tx<SubagentRow[]>`select * from subagents where id = ${opts.subagentId} and thread_id = ${opts.threadId} for update`;
    if (!sa) return { error: `No subagent ${opts.subagentId} in this thread.` };
    if (sa.status === 'cancelled' || sa.status === 'expired') return { msg: `Subagent ${sa.id} is already ${sa.status}.`, cards: [] as number[] };
    if (sa.status === 'idle') {
      await tx`update subagents set status = 'cancelled' where id = ${sa.id}`;
      return { msg: `Subagent ${sa.id} was idle; it is now closed.`, cards: [] };
    }
    const queued = await tx<{ cardId: number | null }[]>`
      update runs set status = 'cancelled', cancel_requested = true, finished_at = now()
      where subagent_id = ${sa.id} and status = 'queued' returning card_id`;
    const running = await tx<{ cardId: number | null }[]>`
      update runs set cancel_requested = true where subagent_id = ${sa.id} and status = 'running' returning card_id`;
    // Steers nobody has seen yet are moot now; left unconsumed they would keep a finishing run from ending ('inbox').
    await tx`update subagent_inbox set consumed_at = now() where subagent_id = ${sa.id} and consumed_at is null`;
    if (running.length === 0) await tx`update subagents set status = 'cancelled' where id = ${sa.id}`;
    return {
      msg: running.length ? `Cancellation requested for ${sa.id}; it stops at its next step.` : `Subagent ${sa.id} cancelled.`,
      cards: [...queued, ...running].map((r) => Number(r.cardId)).filter(Boolean),
      queuedCards: queued.map((r) => Number(r.cardId)).filter(Boolean),
    };
  });
  if ('error' in out) throw new ToolError(out.error);
  await appendEvent(opts.threadId, 'cancel', opts.actor, { subagentId: opts.subagentId });
  // Coding agents have no loop that checks the flag: stop the Cursor run now (the poller retries if this fails).
  if (coding) await cancelCodingAgentNow(opts.subagentId);
  for (const c of new Set(out.cards)) await scheduleCardRender(c);
  for (const c of new Set((out as any).queuedCards ?? [])) await maybeSynthesize(c as number);
  return out.msg;
}

/**
 * Bulk cancels (old "Stop all" buttons, a deleted thread root) only reach coding agents (Cursor) when the admin did
 * it: cancelling one is admin-only. Their cancel flag is acted on by the Cursor poller.
 */
function codingAgentsFilter(actor: string) {
  return isCursorAdmin(actor) ? sql`true` : sql`not exists (select 1 from subagents s where s.id = runs.subagent_id and s.kind = 'cursor')`;
}

/** "Stop all" on a card: cancel every active run on it. */
export async function cancelCardRuns(cardId: number, actor: string): Promise<void> {
  const rows = await sql.begin(async (tx) => {
    const queued = await tx<{ subagentId: string; threadId: string }[]>`
      update runs set status = 'cancelled', cancel_requested = true, finished_at = now()
      where card_id = ${cardId} and status = 'queued' returning subagent_id, thread_id`;
    for (const q of queued) {
      // A subagent whose only active run was queued is now cancelled.
      await tx`update subagents set status = 'cancelled' where id = ${q.subagentId}
               and not exists (select 1 from runs where subagent_id = ${q.subagentId} and status = 'running')`;
    }
    const running = await tx<{ threadId: string }[]>`
      update runs set cancel_requested = true where card_id = ${cardId} and status = 'running' and ${codingAgentsFilter(actor)} returning thread_id`;
    return [...queued, ...running];
  });
  if (rows[0]) await appendEvent(rows[0].threadId, 'stop_all', actor, { cardId });
  await scheduleCardRender(cardId);
  await maybeSynthesize(cardId);
}

/**
 * Native stop / "stop everything" for a thread: cancel every active run in it (queued → cancelled now, running →
 * cancel_requested, stops at the next step), like "Stop all" on each card. Returns the affected card ids.
 */
export async function cancelThreadRuns(threadId: string, actor: string): Promise<number[]> {
  const rows = await sql.begin(async (tx) => {
    const queued = await tx<{ subagentId: string; cardId: number | null }[]>`
      update runs set status = 'cancelled', cancel_requested = true, finished_at = now()
      where thread_id = ${threadId} and status = 'queued' returning subagent_id, card_id`;
    for (const q of queued) {
      await tx`update subagents set status = 'cancelled' where id = ${q.subagentId}
               and not exists (select 1 from runs where subagent_id = ${q.subagentId} and status = 'running')`;
    }
    const running = await tx<{ cardId: number | null }[]>`
      update runs set cancel_requested = true where thread_id = ${threadId} and status = 'running' and ${codingAgentsFilter(actor)} returning card_id`;
    return [...queued, ...running];
  });
  const cards = [...new Set(rows.map((r) => Number(r.cardId)).filter(Boolean))];
  if (rows.length) await appendEvent(threadId, 'stop_all', actor, { thread: true, cards, runs: rows.length });
  for (const c of cards) {
    await scheduleCardRender(c);
    await maybeSynthesize(c);
  }
  return cards;
}

export type RunOutcome =
  | { status: 'complete'; result: string; output: string }
  | { status: 'error'; error: string }
  | { status: 'cancelled' };

/**
 * Atomically finish a run. For `complete`, refuses (returns 'inbox') when steer messages arrived that the run has
 * not seen yet, so the loop can continue instead of dropping them. Returns 'gone' if the run was already
 * terminal (e.g. the sweeper got there first). A run that completes after cancellation was requested is recorded
 * as `cancelled` (its result text is kept for the logs) so it is never reported as a fresh result.
 */
export async function finishRun(
  run: Pick<RunRow, 'id' | 'subagentId' | 'threadId' | 'cardId'>,
  outcome: RunOutcome,
  extra: {
    tokens?: number;
    history?: ModelMessage[];
    /** Finish even with unseen steers (they are dropped like a failed run's): a cancelled coding agent, a bounded retry. */
    dropInbox?: boolean;
    /** Checked inside the transaction (after the subagent lock); false → 'gone', nothing written (e.g. a lost claim). */
    guard?: (tx: TransactionSql<{}>) => Promise<boolean>;
  } = {},
): Promise<'ok' | 'inbox' | 'gone'> {
  let finalStatus: RunOutcome['status'] = outcome.status;
  const res = await sql.begin(async (tx) => {
    await tx`select id from subagents where id = ${run.subagentId} for update`;
    if (extra.guard && !(await extra.guard(tx))) return 'gone' as const;
    if (outcome.status === 'complete' && !extra.dropInbox) {
      // A run that finished despite a cancel request still reports its result; the front agent decides what to say.
      const [p] = await tx<{ n: number }[]>`select count(*)::int as n from subagent_inbox where subagent_id = ${run.subagentId} and consumed_at is null`;
      if ((p?.n ?? 0) > 0) return 'inbox' as const;
    }
    const updated = await tx`
      update runs set status = ${finalStatus},
        result = ${outcome.status === 'complete' ? outcome.result : null},
        output = ${outcome.status === 'complete' ? outcome.output : null},
        error = ${outcome.status === 'error' ? outcome.error : null},
        details = null,
        tokens = ${extra.tokens ?? 0},
        finished_at = now()
      where id = ${run.id} and status = 'running' returning id`;
    if (updated.length === 0) return 'gone' as const;
    const history = extra.history ? sql.json(extra.history as any) : null;
    if (finalStatus === 'cancelled') {
      await tx`update subagents set status = 'cancelled', last_active_at = now(), history = coalesce(${history}, history) where id = ${run.subagentId}`;
    } else {
      const summary = outcome.status === 'complete' ? outcome.output : null;
      await tx`update subagents set status = case when status = 'running' then 'idle' else status end,
                 summary = coalesce(${summary}, summary), last_active_at = now(),
                 history = coalesce(${history}, history)
               where id = ${run.subagentId}`;
    }
    // Leftover inbox messages of a failed/cancelled run are dropped (consumed) so they don't leak into a resume.
    await tx`update subagent_inbox set consumed_at = now() where subagent_id = ${run.subagentId} and consumed_at is null`;
    return 'ok' as const;
  });
  if (res !== 'ok') return res;
  await appendEvent(run.threadId, 'run_finished', `subagent:${run.subagentId}`, {
    runId: run.id,
    status: finalStatus,
    output: outcome.status === 'complete' ? outcome.output : undefined,
    error: outcome.status === 'error' ? outcome.error : undefined,
  });
  await scheduleCardRender(run.cardId);
  await maybeSynthesize(run.cardId);
  return 'ok';
}

/** Mark runs errored without a live loop (sweeper / shutdown). Returns affected card ids. */
export async function failRuns(where: { runIds: number[] }, reason: string): Promise<number[]> {
  if (where.runIds.length === 0) return [];
  const rows = await sql<{ id: number; subagentId: string; threadId: string; cardId: number | null }[]>`
    update runs set status = 'error', error = ${reason}, details = null, finished_at = now()
    where id = any(${where.runIds}::bigint[]) and status in ('queued', 'running')
    returning id, subagent_id, thread_id, card_id`;
  for (const r of rows) {
    await sql`update subagents set status = 'idle', last_active_at = now() where id = ${r.subagentId} and status = 'running'
              and not exists (select 1 from runs where subagent_id = ${r.subagentId} and status in ('queued', 'running'))`;
    await appendEvent(r.threadId, 'run_finished', `subagent:${r.subagentId}`, { runId: Number(r.id), status: 'error', error: reason });
  }
  const cards = [...new Set(rows.map((r) => Number(r.cardId)).filter(Boolean))];
  for (const c of cards) {
    await scheduleCardRender(c);
    await maybeSynthesize(c);
  }
  return cards;
}

/**
 * When the last active run on a card reaches a terminal state, request exactly one synthesis turn
 * (guarded by `cards.synthesized` under a row lock).
 */
export async function maybeSynthesize(cardId: number | null | undefined): Promise<boolean> {
  if (!cardId) return false;
  const req = await sql.begin(async (tx) => {
    const [card] = await tx<{ id: number; threadId: string; synthesized: boolean; turnId: number | null }[]>`
      select id, thread_id, synthesized, turn_id from cards where id = ${cardId} for update`;
    if (!card || card.synthesized) return null;
    const [c] = await tx<{ active: number; total: number }[]>`
      select count(*) filter (where status in ('queued', 'running'))::int as active, count(*)::int as total from runs where card_id = ${cardId}`;
    if (!c || c.total === 0 || c.active > 0) return null;
    const [author] = await tx<{ authorId: string }[]>`
      select coalesce((select author_id from turns where id = ${card.turnId}),
                      (select s.owner_id from runs r join subagents s on s.id = r.subagent_id where r.card_id = ${cardId} order by r.id limit 1)) as author_id`;
    await tx`update cards set synthesized = true where id = ${cardId}`;
    return { threadId: card.threadId, authorId: author!.authorId };
  });
  if (!req) return false;
  try {
    await requestTurn({ threadId: req.threadId, authorId: req.authorId, kind: 'synthesis', cardId });
    await appendEvent(req.threadId, 'synthesis_requested', 'system', { cardId });
    return true;
  } catch (err) {
    log.error({ err, cardId }, 'requestTurn for synthesis failed');
    await sql`update cards set synthesized = false where id = ${cardId}`;
    return false;
  }
}
