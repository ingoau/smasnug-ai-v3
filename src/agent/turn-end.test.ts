import { describe, expect, it } from 'vitest';
import { LOOKUP_TOOLS } from './lookup-guard.js';
import { decidePlainText, endsTurnAfterStep, PLAIN_TEXT_NUDGE_NOTE, postablePlainText, replyEndsWithLookups, responseSucceeded, RESPONSE_TOOLS, TERMINAL_SAFE_TOOLS } from './turn-end.js';

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

describe('postablePlainText', () => {
  it('posts message-shaped answers', () => {
    for (const t of ['The answer is 42.', 'Yes, it ships on Friday.', 'Here are the three options:\n- a\n- b\n- c', "It's in #general, pinned by <@U1>."]) expect(postablePlainText(t), t).toBe(true);
  });
  it('posts real answers that were lost in prod (first-person, "this is…", talk about tools)', () => {
    for (const t of [
      "ok, I'll leave it. It's your call. Just know the venue may ask who supervises minors.",
      'This is just the quote notification from ROJO. The amounts aren\'t in the email.',
      "I'm going to skip this one. It's a `sudo bash` installer that enrolls the sandbox into an outside server.",
      'the way i\'d defined it, each `wake_when` belongs to its own card. a new `spawn_subagent` call gets its own card.',
    ])
      expect(postablePlainText(t), t).toBe(true);
  });
  it('not meta text about not replying, bracketed asides or very short text', () => {
    for (const t of ['No reply needed.', 'No response needed here.', '(no response)', '[silent]', '*stays quiet*', 'Nothing to add.', 'Staying silent.', 'Ending my turn.', 'N/A', 'Okay!', 'Sure.', 'none needed'])
      expect(postablePlainText(t), t).toBe(false);
  });
  it('not reasoning or tool talk', () => {
    for (const t of [
      'The user is asking about the deploy, I should check the logs first.',
      'User wants a summary of the thread.',
      "They're asking for the schedule, so I'll look it up.",
      'I should reply with the link they asked for.',
      "I'll search for that now and get back to them.",
      'Let me look that up in the docs.',
      'I think I should say something',
      'This message is just a thank-you, so no reply needed.',
      'Okay, so the question is about pricing.',
      'Calling end_turn since nothing is needed.',
      'Sending this with the reply tool now.',
      'Here is my answer for the user: 42.',
    ])
      expect(postablePlainText(t), t).toBe(false);
  });
  it('substantial: a longer bar when something else already went out', () => {
    expect(postablePlainText('All done here.', { substantial: true })).toBe(false);
    expect(postablePlainText('Done. The deploy finished and all three services are healthy again.', { substantial: true })).toBe(true);
  });
});

describe('decidePlainText', () => {
  const base = { text: 'The answer is 42.', toolCalls: 0, nudged: false, messaged: false, visible: false, stopping: false, stepsUsed: 1, maxSteps: 12 };
  it('posts a postable text when nothing went out, also after a nudge or at the step limit', () => {
    expect(decidePlainText(base)).toBe('post');
    expect(decidePlainText({ ...base, nudged: true })).toBe('post');
    expect(decidePlainText({ ...base, stepsUsed: 12 })).toBe('post');
  });
  it('never posts when stopping, after a message, for empty text or a step with tool calls', () => {
    expect(decidePlainText({ ...base, stopping: true })).toBe('none');
    expect(decidePlainText({ ...base, messaged: true, visible: true })).toBe('none');
    expect(decidePlainText({ ...base, text: '  \n' })).toBe('none');
    expect(decidePlainText({ ...base, toolCalls: 1 })).toBe('none');
  });
  it('after only a reaction (or spawn): posts substantial text, otherwise ends without a nudge', () => {
    const long = 'Done. The deploy finished and all three services are healthy again, queue is draining.';
    expect(decidePlainText({ ...base, visible: true, text: long })).toBe('post');
    expect(decidePlainText({ ...base, visible: true })).toBe('none');
  });
  it('nudges once for text that is not postable, with nothing visible and a step left', () => {
    const reasoning = { ...base, text: 'The user wants the answer, so 42.' };
    expect(decidePlainText(reasoning)).toBe('nudge');
    expect(decidePlainText({ ...reasoning, nudged: true })).toBe('none');
    expect(decidePlainText({ ...reasoning, visible: true })).toBe('none');
    expect(decidePlainText({ ...reasoning, stepsUsed: 12 })).toBe('none');
    expect(decidePlainText({ ...base, text: 'No reply needed.' })).toBe('nudge');
  });
  it('the nudge note asks for a first message, never an apology for a lost one', () => {
    expect(PLAIN_TEXT_NUDGE_NOTE).toContain('first message');
    expect(PLAIN_TEXT_NUDGE_NOTE).toMatch(/apologi[sz]e/);
    expect(PLAIN_TEXT_NUDGE_NOTE).toContain('end_turn');
    expect(PLAIN_TEXT_NUDGE_NOTE).not.toContain("wasn't shown");
  });
});

describe('replyEndsWithLookups', () => {
  const c = (toolName: string, input?: unknown) => ({ toolCallId: toolName, toolName, input });
  it('a final reply next to a lookup', () => {
    expect(replyEndsWithLookups([c('reply', { text: 'x' }), c('web_search')], LOOKUP_TOOLS)).toBe(true);
    expect(replyEndsWithLookups([c('ask_thread'), c('reply', { text: 'x', continue_turn: false })], LOOKUP_TOOLS)).toBe(true);
  });
  it('not with continue_turn, without lookups, or for a reaction', () => {
    expect(replyEndsWithLookups([c('reply', { text: 'x', continue_turn: true }), c('web_search')], LOOKUP_TOOLS)).toBe(false);
    expect(replyEndsWithLookups([c('reply', { text: 'x' }), c('spawn_subagent')], LOOKUP_TOOLS)).toBe(false);
    expect(replyEndsWithLookups([c('react', { emoji: 'eyes' }), c('web_search')], LOOKUP_TOOLS)).toBe(false);
  });
  it('the turn does not end after such a step (endsTurnAfterStep)', () => {
    const calls = [c('reply', { text: 'x' }), c('web_search')];
    expect(endsTurnAfterStep(calls, [{ toolCallId: 'reply', toolName: 'reply', output: 'Replied (posted).' }, { toolCallId: 'web_search', toolName: 'web_search', output: '[]' }])).toBe(false);
  });
});
