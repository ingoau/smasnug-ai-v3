import { describe, expect, it } from 'vitest';
import type { TraceStep } from '../agent/trace.js';
import { detect, score, selectTurns, summarize, turnStats } from './detectors.js';
import type { EvalTurn } from './types.js';

function turn(over: Partial<EvalTurn> = {}): EvalTurn {
  return {
    turn: { id: 1, threadId: 'C1:1.0', kind: 'user', authorId: 'U1', isMention: true, addressed: true, isDm: false, status: 'done', createdAt: '2026-10-01T00:00:00Z', startedAt: null, finishedAt: null },
    request: [{ userId: 'U1', text: 'hi' }],
    events: [],
    trace: null,
    runs: [],
    followUps: [],
    reactions: [],
    ...over,
  };
}

const step = (calls: [string, unknown, string?][], usage = { input: 1000, output: 10 }): TraceStep => ({
  calls: calls.map(([name, input, output], i) => ({ id: `${name}${i}`, name, input, output: output ?? 'ok' })),
  usage,
  finishReason: 'tool-calls',
});
const trace = (steps: TraceStep[]) => ({ model: 'm', promptHash: 'h', gitSha: null, outcome: 'done', error: null, input: [], steps });
const codes = (t: EvalTurn) => detect(t).map((f) => f.code);

describe('detect', () => {
  it('a clean turn has no flags', () => {
    expect(codes(turn({ trace: trace([step([['reply', { text: 'hello' }]])]) }))).toEqual([]);
  });

  it('flags repeated identical calls, tool errors and late skills', () => {
    const t = turn({
      trace: trace([
        step([['web_search', { q: 'a' }]]),
        step([['web_search', { q: 'a' }, 'Error: rate limited']]),
        step([['load_skill', { name: 'bot-source' }]]),
        step([['reply', { text: 'x' }]]),
      ]),
    });
    expect(codes(t)).toEqual(expect.arrayContaining(['repeated_call', 'tool_errors', 'skill_late']));
    expect(turnStats(t)).toMatchObject({ steps: 4, inputTokens: 4000, skills: ['bot-source'] });
  });

  it('flags many steps and heavy turns', () => {
    const steps = Array.from({ length: 7 }, (_, i) => step([['read_thread', { i }]], { input: 30_000, output: 10 }));
    expect(codes(turn({ trace: trace(steps) }))).toEqual(expect.arrayContaining(['many_steps', 'token_heavy']));
  });

  it('reads outcome events, corrections and reactions', () => {
    const t = turn({
      events: [
        { type: 'turn_stopped', actor: 'system', payload: { turnId: 1 }, at: '' },
        { type: 'reply', actor: 'bot', payload: { turnId: 1, fallback: true }, at: '' },
        { type: 'plain_text_nudge', actor: 'system', payload: { turnId: 1 }, at: '' },
        { type: 'lookup_guard', actor: 'system', payload: { turnId: 1, guard: 'restrict' }, at: '' },
      ],
      followUps: [{ userId: 'U1', text: "no, I meant the other channel", minutesAfter: 2 }],
      reactions: [{ name: '-1', count: 1 }],
    });
    expect(codes(t)).toEqual(expect.arrayContaining(['stopped', 'fallback_reply', 'plain_text', 'lookup_guard', 'user_correction', 'negative_reaction']));
  });

  it('ignores corrections from others or long after', () => {
    expect(codes(turn({ followUps: [{ userId: 'U2', text: 'no way', minutesAfter: 1 }] }))).toEqual([]);
    expect(codes(turn({ followUps: [{ userId: 'U1', text: 'no thanks', minutesAfter: 60 }] }))).toEqual([]);
    expect(codes(turn({ followUps: [{ userId: 'U1', text: 'nice, thanks', minutesAfter: 1 }] }))).toEqual([]);
  });

  it('falls back to turn_tools and turn_timing without a trace', () => {
    const t = turn({
      events: [
        { type: 'turn_tools', actor: 'bot', payload: { turnId: 1, calls: [{ tool: 'slack_search', args: '{"q":"a"}' }, { tool: 'slack_search', args: '{"q":"a"}' }] }, at: '' },
        { type: 'turn_timing', actor: 'system', payload: { turnId: 1, counters: { model_steps: 3, input_tokens: 9000 }, headline: { turnEndMs: 90_000, firstTextMs: 1000 } }, at: '' },
      ],
    });
    expect(codes(t)).toEqual(expect.arrayContaining(['repeated_call', 'slow_turn']));
    expect(turnStats(t)).toMatchObject({ steps: 3, inputTokens: 9000, turnEndMs: 90_000 });
  });

  it('flags failed and heavy subagent runs', () => {
    const t = turn({ runs: [{ id: 9, status: 'error', tokens: 300_000, error: 'Timed out', instructions: 'x', result: null, ms: 1, steps: [], trace: null }] });
    expect(codes(t)).toEqual(expect.arrayContaining(['run_failed', 'run_heavy']));
  });
});

describe('summarize / selectTurns', () => {
  it('ranks flagged turns and samples baseline ones', () => {
    const scored = [
      score(turn({ turn: { ...turn().turn, id: 1 } })),
      score(turn({ turn: { ...turn().turn, id: 2 }, reactions: [{ name: '-1', count: 1 }] })),
      score(turn({ turn: { ...turn().turn, id: 3 }, events: [{ type: 'error', actor: 'bot', payload: { error: 'x' }, at: '' }], reactions: [{ name: '-1', count: 1 }] })),
      score(turn({ turn: { ...turn().turn, id: 4 } })),
    ];
    const picked = selectTurns(scored, 5, 1, () => 0);
    expect(picked.flagged.map((t) => t.turn.id)).toEqual([3, 2]);
    expect(picked.controls.map((t) => t.turn.id)).toEqual([1]);
    const s = summarize(scored);
    expect(s).toMatchObject({ turns: 4, flagged: 2 });
    expect(s.flags).toContainEqual({ code: 'negative_reaction', turns: 2 });
  });
});
