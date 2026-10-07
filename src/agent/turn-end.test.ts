import { describe, expect, it } from 'vitest';
import { endsTurnAfterStep, responseSucceeded, RESPONSE_TOOLS, TERMINAL_SAFE_TOOLS } from './turn-end.js';

let n = 0;
const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolCallId: `c${++n}`, toolName, input });
const ok = (c: { toolCallId: string; toolName: string }, output: unknown) => ({ toolCallId: c.toolCallId, toolName: c.toolName, output });

describe('responseSucceeded', () => {
  it('recognises delivered replies, reactions and removals', () => {
    expect(responseSucceeded('reply', 'Replied (streamed).')).toBe(true);
    expect(responseSucceeded('reply', 'Replied (posted) with buttons: a | b.')).toBe(true);
    expect(responseSucceeded('reply', 'Not posted: the reply was empty. To stay silent, call end_turn.')).toBe(false);
    expect(responseSucceeded('reply', 'Not delivered: the user pressed stop. Do not retry; call end_turn.')).toBe(false);
    expect(responseSucceeded('react', 'Reacted :eyes: to 1.2.')).toBe(true);
    expect(responseSucceeded('react', 'Already reacted :eyes:.')).toBe(true);
    expect(responseSucceeded('react', ":nope: doesn't exist here; Reacted :thumbsup: to 1.2.")).toBe(true);
    expect(responseSucceeded('react', 'Reaction skipped.')).toBe(false);
    expect(responseSucceeded('unreact', 'Removed :hourglass: from 1.2.')).toBe(true);
    expect(responseSucceeded('unreact', 'No such reaction from you.')).toBe(false);
  });
});

describe('endsTurnAfterStep', () => {
  it('ends after a successful reply or reaction alone', () => {
    const r = call('reply', { text: 'hi' });
    expect(endsTurnAfterStep([r], [ok(r, 'Replied (streamed).')])).toBe(true);
    const re = call('react', { emoji: 'eyes' });
    expect(endsTurnAfterStep([re], [ok(re, 'Reacted :eyes: to 1.2.')])).toBe(true);
  });

  it('keeps going when the reply failed, or asked to continue', () => {
    const empty = call('reply', { text: '' });
    expect(endsTurnAfterStep([empty], [ok(empty, 'Not posted: the reply was empty.')])).toBe(false);
    const cont = call('reply', { text: 'on it', continue_turn: true });
    expect(endsTurnAfterStep([cont], [ok(cont, 'Replied (streamed).')])).toBe(false);
    const skipped = call('react', { emoji: 'x' });
    expect(endsTurnAfterStep([skipped], [ok(skipped, 'Reaction skipped.')])).toBe(false);
    const noResult = call('reply', { text: 'x' });
    expect(endsTurnAfterStep([noResult], [])).toBe(false);
  });

  it('ends with terminal-safe calls alongside (ack + spawn, reply + remember)', () => {
    const r = call('reply', { text: 'on it' });
    const s = call('spawn_subagent', { tasks: [] });
    expect(endsTurnAfterStep([r, s], [ok(r, 'Replied (posted).'), ok(s, { started: [] })])).toBe(true);
    const m = call('remember', { fact: 'x' });
    const t = call('leave_thread', {});
    expect(endsTurnAfterStep([r, m, t], [ok(r, 'Replied (posted).'), ok(m, 'ok'), ok(t, 'ok')])).toBe(true);
  });

  it('continues when another call needs its result (search, fetch, read, ask_thread, list)', () => {
    const r = call('reply', { text: 'checking' });
    for (const name of ['web_search', 'slack_search', 'fetch_url', 'read_thread', 'ask_thread', 'read_canvas', 'list_reminders', 'search_emojis', 'create_canvas']) {
      const other = call(name);
      expect(endsTurnAfterStep([r, other], [ok(r, 'Replied (posted).'), ok(other, 'results')]), name).toBe(false);
    }
  });

  it('continues when a terminal-safe call failed (no result: the model must hear about it)', () => {
    const r = call('reply', { text: 'on it' });
    const s = call('spawn_subagent', { tasks: [] });
    expect(endsTurnAfterStep([r, s], [ok(r, 'Replied (posted).')])).toBe(false);
  });

  it('never ends a step without a response tool (end_turn handles silent turns)', () => {
    const s = call('spawn_subagent');
    expect(endsTurnAfterStep([s], [ok(s, {})])).toBe(false);
    expect(endsTurnAfterStep([], [])).toBe(false);
  });

  it('keeps the lists disjoint', () => {
    for (const t of RESPONSE_TOOLS) expect(TERMINAL_SAFE_TOOLS.has(t)).toBe(false);
  });
});
