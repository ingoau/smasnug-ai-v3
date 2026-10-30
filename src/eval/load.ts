/** Load finished turns with their events, traces, subagent runs, follow-ups and reactions (docs/evals.md). */
import { sql } from '../db/index.js';
import type { EvalEvent, EvalRun, EvalTrace, EvalTurn } from './types.js';

const FOLLOW_UP_WINDOW_MIN = 30;
const FOLLOW_UPS = 3;
const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());
const tsDate = (ts: string) => new Date(Number(ts) * 1000);

function toTrace(r: any): EvalTrace {
  return { model: r.model, promptHash: r.promptHash, gitSha: r.gitSha, outcome: r.outcome, error: r.error, input: r.input ?? [], steps: r.steps ?? [] };
}

export async function loadTurns(opts: { since: Date; until?: Date; includeDms?: boolean }): Promise<EvalTurn[]> {
  const until = opts.until ?? new Date();
  const turns = await sql<any[]>`
    select t.id, t.thread_id, t.kind, t.author_id, t.is_mention, t.addressed, t.status, t.message_ts,
           t.created_at, t.started_at, t.finished_at, th.is_dm
    from turns t join threads th on th.id = t.thread_id
    where t.created_at >= ${opts.since} and t.created_at < ${until} and t.status in ('done', 'error', 'cancelled')
      and t.started_at is not null ${opts.includeDms === false ? sql`and not th.is_dm` : sql``}
    order by t.id`;
  if (!turns.length) return [];
  const ids = turns.map((t) => Number(t.id));
  const threadIds = [...new Set(turns.map((t) => t.threadId as string))];

  const [events, traces, runs, messages] = await Promise.all([
    sql<any[]>`
      select type, actor, payload, created_at from thread_events
      where thread_id = any(${threadIds}) and created_at >= ${opts.since} and (payload ? 'turnId' or payload ? 'runId')
      order by id`,
    sql<any[]>`select * from traces where turn_id = any(${ids}) order by id`,
    sql<any[]>`
      select id, turn_id, status, tokens, error, instructions, left(result, 4000) as result, started_at, finished_at
      from runs where turn_id = any(${ids}) order by id`,
    sql<any[]>`
      select thread_id, ts, user_id, bot_id, text, reactions from messages
      where thread_id = any(${threadIds}) and not deleted and created_at >= ${opts.since}
      order by thread_id, ts::numeric`,
  ]);

  const byTurn = new Map<number, EvalEvent[]>();
  const runSteps = new Map<number, Record<string, any>[]>();
  for (const e of events) {
    const ev: EvalEvent = { type: e.type, actor: e.actor, payload: e.payload, at: iso(e.createdAt)! };
    if (e.payload?.turnId != null) {
      const id = Number(e.payload.turnId);
      if (!byTurn.has(id)) byTurn.set(id, []);
      byTurn.get(id)!.push(ev);
    } else if (e.type === 'run_step' && e.payload?.runId != null) {
      const id = Number(e.payload.runId);
      if (!runSteps.has(id)) runSteps.set(id, []);
      runSteps.get(id)!.push(e.payload);
    }
  }
  const frontTrace = new Map<number, EvalTrace>();
  const runTrace = new Map<number, EvalTrace>();
  for (const t of traces) {
    if (t.kind === 'front' && t.turnId != null) frontTrace.set(Number(t.turnId), toTrace(t));
    if (t.kind === 'run' && t.runId != null) runTrace.set(Number(t.runId), toTrace(t));
  }
  const runsByTurn = new Map<number, EvalRun[]>();
  for (const r of runs) {
    const id = Number(r.turnId);
    if (!runsByTurn.has(id)) runsByTurn.set(id, []);
    runsByTurn.get(id)!.push({
      id: Number(r.id),
      status: r.status,
      tokens: Number(r.tokens ?? 0),
      error: r.error,
      instructions: r.instructions,
      result: r.result,
      ms: r.startedAt && r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : null,
      steps: runSteps.get(Number(r.id)) ?? [],
      trace: runTrace.get(Number(r.id)) ?? null,
    });
  }
  const msgsByThread = new Map<string, any[]>();
  for (const m of messages) {
    if (!msgsByThread.has(m.threadId)) msgsByThread.set(m.threadId, []);
    msgsByThread.get(m.threadId)!.push(m);
  }

  return turns.map((t): EvalTurn => {
    const id = Number(t.id);
    const msgs = msgsByThread.get(t.threadId) ?? [];
    const trigger = new Set<string>(t.messageTs ?? []);
    const started = t.startedAt ? new Date(t.startedAt).getTime() : 0;
    const finished = t.finishedAt ? new Date(t.finishedAt).getTime() : started;
    const reactions = new Map<string, number>();
    for (const m of msgs) {
      const at = tsDate(m.ts).getTime();
      if (!m.botId || at < started || at > finished + 10_000) continue;
      for (const r of Array.isArray(m.reactions) ? m.reactions : []) reactions.set(r.name, (reactions.get(r.name) ?? 0) + Number(r.count ?? r.users?.length ?? 1));
    }
    const followUps = msgs
      .filter((m) => !m.botId && !trigger.has(m.ts) && tsDate(m.ts).getTime() > finished && tsDate(m.ts).getTime() - finished <= FOLLOW_UP_WINDOW_MIN * 60_000)
      .slice(0, FOLLOW_UPS)
      .map((m) => ({ userId: m.userId, text: String(m.text ?? '').slice(0, 1000), minutesAfter: Math.round(((tsDate(m.ts).getTime() - finished) / 60_000) * 10) / 10 }));
    return {
      turn: {
        id,
        threadId: t.threadId,
        kind: t.kind,
        authorId: t.authorId,
        isMention: t.isMention,
        addressed: t.addressed,
        isDm: t.isDm,
        status: t.status,
        createdAt: iso(t.createdAt)!,
        startedAt: iso(t.startedAt),
        finishedAt: iso(t.finishedAt),
      },
      request: msgs.filter((m) => trigger.has(m.ts)).map((m) => ({ userId: m.userId, text: String(m.text ?? '').slice(0, 4000) })),
      events: byTurn.get(id) ?? [],
      trace: frontTrace.get(id) ?? null,
      runs: runsByTurn.get(id) ?? [],
      followUps,
      reactions: [...reactions].map(([name, count]) => ({ name, count })),
    };
  });
}

/** System prompts by hash (prompt_versions). */
export async function loadPrompts(hashes: string[]): Promise<Map<string, string>> {
  if (!hashes.length) return new Map();
  const rows = await sql<{ hash: string; text: string }[]>`select hash, text from prompt_versions where hash = any(${hashes})`;
  return new Map(rows.map((r) => [r.hash, r.text]));
}
