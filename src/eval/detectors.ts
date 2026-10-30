/**
 * Cheap, deterministic signals that a turn went badly or wastefully (docs/evals.md). No model calls: they pick which
 * turns are worth a closer look, and their counts are the before/after numbers for a prompt or skill change.
 */
import type { TraceStep } from '../agent/trace.js';
import type { EvalEvent, EvalTurn, Flag, ScoredTurn, TurnStats } from './types.js';

export const THRESHOLDS = {
  frontSteps: 6,
  frontInputTokens: 150_000,
  slowTurnMs: 60_000,
  slowFirstTextMs: 20_000,
  runTokens: 250_000,
  runSteps: 20,
  correctionWindowMin: 15,
} as const;

/** Reactions on a bot reply that mean it missed (Slack names; skin tones are stripped first). */
export const NEGATIVE_REACTIONS = new Set(['-1', 'x', 'no_entry', 'no_entry_sign', 'disappointed', 'confused', 'face_with_raised_eyebrow']);
export const isNegativeReaction = (name: string) => NEGATIVE_REACTIONS.has(name.replace(/::skin-tone-\d$/, ''));

/** A follow-up that corrects or re-asks ("no, I meant…", "that's wrong", "you forgot…"). */
const CORRECTION =
  /^\s*(?:<@\w+>\s*)?(?:no\b|nope\b|nah\b|wrong\b|incorrect\b|that'?s (?:not|wrong|incorrect)|not (?:what|quite)|i meant\b|i said\b|i asked\b|actually\b|you (?:didn'?t|forgot|missed|ignored)|why (?:did|would) you|try again|still (?:wrong|not)|that'?s not it)/i;
/** …but not a polite closer ("no worries", "nope that's all", "actually that's perfect"). */
const NOT_CORRECTION =
  /^\s*(?:<@\w+>\s*)?(?:(?:no|nope|nah)[\s,!.]*(?:worries|problem|prob|thanks|thank you|ty|need|that'?s (?:all|it|fine|good|perfect)|all good|i'?m good|good|fine|that'?s all|it'?s fine|it'?s ok)|actually[\s,]*(?:that'?s |this is |it'?s )?(?:perfect|great|good|nice|awesome|helpful|works|right|correct)|not quite (?:what i expected but|but) (?:good|fine))/i;
export const isCorrection = (text: string) => CORRECTION.test(text) && !NOT_CORRECTION.test(text);

const callsOf = (steps: TraceStep[] | undefined) => (steps ?? []).flatMap((s) => s.calls);
const sum = (xs: (number | undefined | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

function eventsOf(t: EvalTurn, type: string): EvalEvent[] {
  return t.events.filter((e) => e.type === type);
}

function timing(t: EvalTurn): Record<string, any> | null {
  return eventsOf(t, 'turn_timing')[0]?.payload ?? null;
}

/** Tool calls of the front turn: the trace when there is one, else the (clipped) turn_tools summary. */
function frontCalls(t: EvalTurn): { name: string; key: string }[] {
  if (t.trace) return callsOf(t.trace.steps).map((c) => ({ name: c.name, key: `${c.name} ${JSON.stringify(c.input)}` }));
  return eventsOf(t, 'turn_tools').flatMap((e) => (Array.isArray(e.payload.calls) ? e.payload.calls : []).map((c: any) => ({ name: String(c.tool), key: `${c.tool} ${c.args}` })));
}

export function turnStats(t: EvalTurn): TurnStats {
  const tm = timing(t);
  const steps = t.trace?.steps.filter((s) => s.usage) ?? null;
  const calls = frontCalls(t);
  const skills = t.trace
    ? callsOf(t.trace.steps)
        .filter((c) => c.name === 'load_skill')
        .map((c) => `${(c.input as any)?.name ?? '?'}${(c.input as any)?.file ? `/${(c.input as any).file}` : ''}`)
    : [];
  return {
    steps: steps ? steps.length : (tm?.counters?.model_steps ?? null),
    inputTokens: steps ? sum(steps.map((s) => s.usage?.input)) : (tm?.counters?.input_tokens ?? null),
    outputTokens: steps ? sum(steps.map((s) => s.usage?.output)) : (tm?.counters?.output_tokens ?? null),
    cachedTokens: steps ? sum(steps.map((s) => s.usage?.cached)) : (tm?.counters?.cached_tokens ?? null),
    turnEndMs: tm?.headline?.turnEndMs ?? null,
    firstTextMs: tm?.headline?.firstTextMs ?? null,
    runs: t.runs.length,
    runTokens: sum(t.runs.map((r) => r.tokens)),
    tools: calls.map((c) => c.name),
    skills,
  };
}

function duplicates(keys: string[]): string[] {
  const seen = new Map<string, number>();
  for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${n}× ${k.length > 160 ? `${k.slice(0, 159)}…` : k}`);
}

/** Tool results that report a failure: an "Error…" string, or a JSON object with `error` / `ok: false`. */
export const looksLikeError = (output: string | undefined) =>
  !!output && (/^"?(?:error|failed|could not|couldn't|unable to)\b/i.test(output) || /^\{"(?:error"\s*:\s*(?!null|false)|ok"\s*:\s*false)/.test(output) || /^\{.{0,200}"ok"\s*:\s*false/.test(output));

export function detect(t: EvalTurn): Flag[] {
  const flags: Flag[] = [];
  const add = (code: string, weight: number, detail: string) => flags.push({ code, weight, detail });
  const s = turnStats(t);

  // Outcome
  const errors = eventsOf(t, 'error');
  for (const e of errors) add('turn_error', 5, String(e.payload.error ?? '').slice(0, 200));
  // Failures outside the model loop (context build, stale turn, shutdown) only show in the status.
  const finished = eventsOf(t, 'turn_finished').at(-1)?.payload;
  if (!errors.length && t.turn.status === 'error') add('turn_error', 5, String(finished?.error ?? finished?.reason ?? 'turn ended with status error').slice(0, 200));
  if (eventsOf(t, 'turn_stopped').length) add('stopped', 4, 'someone stopped the turn (!stop)');
  const fallback = eventsOf(t, 'reply').filter((e) => e.payload.fallback && !e.payload.outcome && !e.payload.canvasLink);
  if (fallback.length) add('fallback_reply', 4, fallback[0]!.payload.fromText ? 'posted unsent plain text as the reply' : 'generic fallback reply');
  if (eventsOf(t, 'reply_dropped').length) add('reply_dropped', 3, `${eventsOf(t, 'reply_dropped').length} reply call(s) dropped`);

  // User reaction
  const author = t.followUps.filter((f) => f.userId === t.turn.authorId && f.minutesAfter <= THRESHOLDS.correctionWindowMin);
  const correction = author.find((f) => isCorrection(f.text));
  if (correction) add('user_correction', 5, correction.text.slice(0, 200));
  const neg = t.reactions.filter((r) => isNegativeReaction(r.name));
  if (neg.length) add('negative_reaction', 5, neg.map((r) => `:${r.name}: ×${r.count}`).join(' '));

  // Model behaviour
  const nudges = eventsOf(t, 'plain_text_nudge').length + eventsOf(t, 'plain_text_reply').length;
  if (nudges) add('plain_text', 2, 'answered in plain text instead of calling reply / end_turn');
  const discarded = eventsOf(t, 'discarded_text').length;
  if (discarded >= 2) add('discarded_text', 1, `${discarded} steps wrote text nobody sees`);
  const guard = eventsOf(t, 'lookup_guard').map((e) => e.payload.guard);
  if (guard.length) add('lookup_guard', guard.includes('restrict') ? 3 : 2, `lookup guard reached "${guard.at(-1)}" (too many lookup-only steps)`);
  if (s.steps != null && s.steps >= THRESHOLDS.frontSteps) add('many_steps', 2, `${s.steps} front steps`);
  if (s.inputTokens != null && s.inputTokens >= THRESHOLDS.frontInputTokens) add('token_heavy', 2, `${s.inputTokens} input tokens in the front turn`);

  const dup = duplicates(frontCalls(t).map((c) => c.key));
  for (const run of t.runs) dup.push(...duplicates(callsOf(run.trace?.steps).map((c) => `${c.name} ${JSON.stringify(c.input)}`)).map((d) => `run ${run.id}: ${d}`));
  if (dup.length) add('repeated_call', 3, dup.slice(0, 3).join('; '));

  const allCalls = [...callsOf(t.trace?.steps), ...t.runs.flatMap((r) => callsOf(r.trace?.steps))];
  const failed = allCalls.filter((c) => c.error || looksLikeError(c.output));
  if (failed.length) add('tool_errors', Math.min(4, failed.length), failed.slice(0, 3).map((c) => `${c.name}: ${(c.error ?? c.output ?? '').slice(0, 120)}`).join('; '));

  // Skills
  const loads = s.skills;
  const repeatedSkill = duplicates(loads);
  if (repeatedSkill.length) add('skill_reloaded', 1, repeatedSkill.join('; '));
  if (t.trace) {
    const firstLoad = t.trace.steps.findIndex((st) => st.calls.some((c) => c.name === 'load_skill'));
    if (firstLoad >= 2) add('skill_late', 2, `load_skill only in step ${firstLoad + 1}`);
  }

  // Latency
  if (s.turnEndMs != null && s.turnEndMs >= THRESHOLDS.slowTurnMs && !t.runs.length) add('slow_turn', 2, `${Math.round(s.turnEndMs / 1000)}s without subagents`);
  if (s.firstTextMs != null && s.firstTextMs >= THRESHOLDS.slowFirstTextMs) add('slow_first_text', 1, `first text after ${Math.round(s.firstTextMs / 1000)}s`);

  // Subagents
  for (const r of t.runs) {
    if (r.status === 'error') add('run_failed', 3, `run ${r.id}: ${r.error ?? 'error'}`);
    if (r.tokens >= THRESHOLDS.runTokens) add('run_heavy', 2, `run ${r.id}: ${r.tokens} tokens`);
    const steps = r.trace ? r.trace.steps.length : r.steps.length;
    if (steps >= THRESHOLDS.runSteps) add('run_long', 2, `run ${r.id}: ${steps} steps`);
  }
  return flags;
}

export function score(t: EvalTurn): ScoredTurn {
  const flags = detect(t);
  return { ...t, flags, score: flags.reduce((a, f) => a + f.weight, 0), stats: turnStats(t) };
}

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export type Summary = {
  turns: number;
  withTrace: number;
  flagged: number;
  flags: { code: string; turns: number }[];
  tools: { name: string; calls: number }[];
  skills: { name: string; loads: number }[];
  percentiles: Record<'steps' | 'inputTokens' | 'turnEndMs' | 'firstTextMs' | 'runTokens', { p50: number | null; p90: number | null; max: number | null }>;
};

export function summarize(turns: ScoredTurn[]): Summary {
  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const dist = (pick: (s: TurnStats) => number | null) => {
    const xs = turns.map((t) => pick(t.stats)).filter((x): x is number => x != null);
    return { p50: pct(xs, 50), p90: pct(xs, 90), max: xs.length ? Math.max(...xs) : null };
  };
  return {
    turns: turns.length,
    withTrace: turns.filter((t) => t.trace).length,
    flagged: turns.filter((t) => t.score > 0).length,
    flags: count(turns.flatMap((t) => [...new Set(t.flags.map((f) => f.code))])).map(([code, n]) => ({ code, turns: n })),
    tools: count(turns.flatMap((t) => t.stats.tools)).map(([name, n]) => ({ name, calls: n })),
    skills: count(turns.flatMap((t) => t.stats.skills)).map(([name, n]) => ({ name, loads: n })),
    percentiles: {
      steps: dist((s) => s.steps),
      inputTokens: dist((s) => s.inputTokens),
      turnEndMs: dist((s) => s.turnEndMs),
      firstTextMs: dist((s) => s.firstTextMs),
      runTokens: dist((s) => (s.runs ? s.runTokens : null)),
    },
  };
}

/** The turns worth a look (highest score first), plus a few unflagged ones as a baseline. */
export function selectTurns(turns: ScoredTurn[], top: number, controls: number, rand: () => number = Math.random): { flagged: ScoredTurn[]; controls: ScoredTurn[] } {
  const flagged = turns.filter((t) => t.score > 0).sort((a, b) => b.score - a.score || b.turn.id - a.turn.id).slice(0, top);
  const clean = turns.filter((t) => t.score === 0);
  const picked: ScoredTurn[] = [];
  while (picked.length < controls && clean.length) picked.push(clean.splice(Math.floor(rand() * clean.length), 1)[0]!);
  return { flagged, controls: picked };
}
