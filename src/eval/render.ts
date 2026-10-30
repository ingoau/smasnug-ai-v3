/** Readable markdown for the eval export (docs/evals.md): one file per turn, plus the summary. */
import type { TraceStep } from '../agent/trace.js';
import type { Summary } from './detectors.js';
import type { EvalTrace, ScoredTurn } from './types.js';

const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\``;
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n}]` : s);
const json = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

function renderSteps(steps: TraceStep[], opts: { output: number }): string {
  return steps
    .map((s, i) => {
      const head = [`#### Step ${i + 1}`, [s.finishReason, s.ms != null ? `${s.ms} ms` : null, s.usage ? `in ${s.usage.input ?? '?'} (cached ${s.usage.cached ?? 0}) / out ${s.usage.output ?? '?'}${s.usage.reasoning ? ` (reasoning ${s.usage.reasoning})` : ''}` : null].filter(Boolean).join(' · ')];
      const body: string[] = [];
      for (const n of s.notes ?? []) body.push(`**Injected note:**\n${fence(short(n, 3000))}`);
      if (s.reasoning) body.push(`**Reasoning:**\n${fence(short(s.reasoning, 4000))}`);
      if (s.text) body.push(`**Text (never shown):**\n${fence(short(s.text, 3000))}`);
      for (const c of s.calls) {
        const result = c.error != null ? `ERROR: ${c.error}` : (c.output ?? '(no result)');
        body.push(`- \`${c.name}\`${c.ms != null ? ` (${c.ms} ms)` : ''} ${short(json(c.input), 1500)}\n${fence(short(result, opts.output))}`);
      }
      return [head.join('\n'), ...body].join('\n\n');
    })
    .join('\n\n');
}

function renderTrace(t: EvalTrace, opts: { input: number; output: number }): string {
  const meta = `model \`${t.model}\` · prompt \`${t.promptHash}\` · commit \`${t.gitSha?.slice(0, 10) ?? '?'}\` · outcome **${t.outcome}**${t.error ? ` (${t.error})` : ''}`;
  const input = t.input.map((m) => `**${m.role}:**\n${fence(short(m.content, opts.input))}`).join('\n\n');
  return `${meta}\n\n<details><summary>Input</summary>\n\n${input}\n\n</details>\n\n${renderSteps(t.steps, opts)}`;
}

export function renderTurn(t: ScoredTurn): string {
  const u = t.turn;
  const lines: string[] = [];
  lines.push(`# Turn ${u.id} (score ${t.score})`);
  lines.push(
    `thread \`${u.threadId}\` · ${u.kind}${u.isMention ? ' · mention' : ''}${u.addressed ? ' · addressed' : ''}${u.isDm ? ' · DM' : ''} · status ${u.status} · ${u.createdAt}`,
  );
  const s = t.stats;
  lines.push(
    `steps ${s.steps ?? '?'} · input tokens ${s.inputTokens ?? '?'} (cached ${s.cachedTokens ?? '?'}) · output ${s.outputTokens ?? '?'} · first text ${s.firstTextMs ?? '?'} ms · end ${s.turnEndMs ?? '?'} ms · runs ${s.runs} (${s.runTokens} tokens)`,
  );
  lines.push('', '## Flags', t.flags.length ? t.flags.map((f) => `- **${f.code}** (${f.weight}): ${f.detail}`).join('\n') : '- none (baseline sample)');
  lines.push('', '## Request', t.request.length ? t.request.map((m) => `<@${m.userId}>: ${short(m.text, 2000)}`).join('\n\n') : '(trigger messages not stored)');
  const replies = t.events.filter((e) => e.type === 'reply' && e.payload.text);
  if (replies.length) lines.push('', '## Bot replies', replies.map((e) => short(String(e.payload.text), 3000)).join('\n\n---\n\n'));
  if (t.followUps.length) lines.push('', '## What came next', t.followUps.map((f) => `- +${f.minutesAfter} min <@${f.userId}>${f.userId === u.authorId ? ' (author)' : ''}: ${short(f.text, 500)}`).join('\n'));
  if (t.reactions.length) lines.push('', `Reactions on the reply: ${t.reactions.map((r) => `:${r.name}: ×${r.count}`).join(' ')}`);
  lines.push('', '## Front agent');
  if (t.trace) lines.push(renderTrace(t.trace, { input: 30_000, output: 2500 }));
  else {
    const calls = t.events.filter((e) => e.type === 'turn_tools').flatMap((e) => e.payload.calls ?? []);
    lines.push('(no trace: recorded before tracing, or saving it failed)', calls.map((c: any) => `- \`${c.tool}\` ${c.args}`).join('\n'));
  }
  for (const r of t.runs) {
    lines.push('', `## Subagent run ${r.id} (${r.status}, ${r.tokens} tokens${r.ms != null ? `, ${Math.round(r.ms / 1000)}s` : ''})`);
    lines.push(`**Instructions:**\n${fence(short(r.instructions, 3000))}`);
    if (r.trace) lines.push(renderSteps(r.trace.steps, { output: 1500 }));
    else if (r.steps.length) lines.push(r.steps.map((st) => `- step ${st.step}: ${(st.tools ?? []).join(', ') || '(text)'} · ${st.ms} ms · in ${st.inputTokens ?? '?'}`).join('\n'));
    if (r.result) lines.push(`**Result:**\n${fence(short(r.result, 2500))}`);
    if (r.error) lines.push(`**Error:** ${r.error}`);
  }
  const other = t.events.filter((e) => !['reply', 'turn_tools', 'turn_timing', 'run_step', 'run_progress'].includes(e.type));
  if (other.length) lines.push('', '## Events', other.map((e) => `- ${e.at} \`${e.type}\` ${short(json(e.payload), 300)}`).join('\n'));
  return `${lines.join('\n')}\n`;
}

export function renderSummary(s: Summary, meta: { since: Date; until: Date; exported: { file: string; turn: ScoredTurn }[]; prompts: string[] }): string {
  const p = s.percentiles;
  const row = (name: string, d: { p50: number | null; p90: number | null; max: number | null }) => `| ${name} | ${d.p50 ?? '–'} | ${d.p90 ?? '–'} | ${d.max ?? '–'} |`;
  return `# Eval export ${meta.since.toISOString()} → ${meta.until.toISOString()}

${s.turns} finished turns, ${s.withTrace} with a full trace, ${s.flagged} flagged.

## Distributions

| metric | p50 | p90 | max |
|---|---|---|---|
${row('front steps', p.steps)}
${row('front input tokens', p.inputTokens)}
${row('turn end (ms)', p.turnEndMs)}
${row('first text (ms)', p.firstTextMs)}
${row('subagent tokens (turns with runs)', p.runTokens)}

## Flags (turns)

${s.flags.map((f) => `- ${f.code}: ${f.turns}`).join('\n') || '- none'}

## Tool calls (front)

${s.tools.slice(0, 30).map((t) => `- ${t.name}: ${t.calls}`).join('\n') || '- none'}

## Skills loaded

${s.skills.map((t) => `- ${t.name}: ${t.loads}`).join('\n') || '- none (or no traces yet)'}

## Exported turns

${meta.exported.map((e) => `- [${e.file}](${e.file}) score ${e.turn.score}: ${e.turn.flags.map((f) => f.code).join(', ') || 'baseline'}`).join('\n')}

## System prompt versions

${meta.prompts.map((h) => `- [prompts/${h}.md](prompts/${h}.md)`).join('\n') || '- none'}
`;
}
