import '../tools/test-env.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// ---- Slack / DB mocks for the delivery tests ----
const calls: { method: string; args: any }[] = [];
let failOn: ((method: string, args: any) => boolean) | null = null;
vi.mock('../core/slack.js', () => ({
  slackCall: vi.fn(async (method: string, args: any) => {
    calls.push({ method, args });
    if (failOn?.(method, args)) throw Object.assign(new Error(`An API error occurred: invalid_blocks`), { data: { ok: false, error: 'invalid_blocks' } });
    if (method === 'chat.postMessage') return { ok: true, ts: `1700000000.00${String(calls.length).padStart(4, '0')}` };
    return { ok: true, ts: '1700000000.000900', team_id: 'T1' };
  }),
  slackErrorCode: (err: any) => err?.data?.error,
}));
vi.mock('../core/events.js', async (orig) => ({ ...(await orig<typeof import('../core/events.js')>()), appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}) }));
const recorded: { id: number; ts: string; text: string | null }[] = [];
let placedRow: any = null;
let posted = false;
const detached: string[] = [];
vi.mock('./reply-buttons-store.js', () => ({
  loadReplyButtons: vi.fn(async () => placedRow),
  messageHasLiveCard: vi.fn(async () => false),
  detachMessageCards: vi.fn(async (_c: string, ts: string) => (detached.push(ts), [])),
  reattachMessageCards: vi.fn(async () => {}),
  setReplyText: vi.fn(async () => {}),
  postedBefore: vi.fn(async () => posted),
  createReplyButtons: vi.fn(async (o: any) => ({ id: 42, threadId: o.threadId, channelId: o.channelId, turnId: o.turnId, messageTs: null, replyText: null, labels: o.labels, pressedBy: null, pressedLabel: null, pressedMessageTs: null, pressedAt: null })),
  setButtonsMessage: vi.fn(async (id: number, ts: string, text: string | null) => void recorded.push({ id, ts, text })),
  toButtonsState: (r: any) => ({ id: r.id, labels: r.labels, pressedBy: r.pressedBy, pressedLabel: r.pressedLabel }),
}));

const { ReplyManager } = await import('./reply.js');
const { MAX_BUTTONS, MAX_FIXED_REPLY_CHARS, MAX_LABEL_CHARS, SLACK_BUTTON_TEXT_MAX, REPLY_CHOICE_ACTION, REPLY_QUIET_ACTION, buttonPlace, buttonWho, buttonsActions, buttonsBlock, normalizeButtonLabels, normalizeButtons, parseButtonOutcome, parseButtonResponse, placeText, pressedText } = await import('./reply-buttons.js');
const { prepareButtonActions, registerButtonAction, runButtonAction } = await import('./button-actions.js');
const { renderActionFailure } = await import('./reply-quiet.js');
const { renderCard } = await import('./card-render.js');
const { buttonsSchema } = await import('./tools.js');
const { formatMessage } = await import('../context/format.js');

const target = (turnKind: 'user' | 'synthesis' = 'user') => ({
  threadId: 'C1:1.1',
  channelId: 'C1',
  threadTs: '1.1',
  turnId: 1,
  turnKind,
  recipientUserId: 'U1',
  activeRuns: async () => 0,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const actionsOf = (blocks: any[] | undefined) => (blocks ?? []).filter((b) => b.type === 'actions');

beforeEach(() => {
  calls.length = 0;
  recorded.length = 0;
  detached.length = 0;
  placedRow = null;
  posted = false;
  failOn = null;
});

registerButtonAction({
  name: 'unit_echo',
  args: z.object({ say: z.string() }),
  check: async (_ctx, a) => (a.say === 'no' ? 'not allowed' : null),
  run: async (_ctx, a) => (a.say === 'boom' ? Promise.reject(new Error('kaput')) : { ok: true, text: `said ${a.say}` }),
});

describe('reply buttons: labels and schema', () => {
  it(`shows labels as written: only ping neutralising, Slack's 75-char limit and at most ${MAX_BUTTONS}`, () => {
    const labels = normalizeButtonLabels(['  Yes ', 'yes', '', '   ', '## hidden', 'tell <!channel>', 'x'.repeat(50), 'six', 'seven']);
    expect(labels).toHaveLength(MAX_BUTTONS);
    expect(labels.slice(0, 3)).toEqual(['  Yes ', 'yes', '## hidden']); // no trimming, dedupe or prefix stripping
    expect(labels[3]).not.toMatch(/<!channel>/);
    expect(labels[4]).toBe('x'.repeat(50)); // longer than the suggested 30 chars: untouched
    expect(normalizeButtonLabels(['a'.repeat(SLACK_BUTTON_TEXT_MAX + 5)])[0]).toBe('a'.repeat(SLACK_BUTTON_TEXT_MAX));
    expect(normalizeButtonLabels(undefined)).toEqual([]);
    expect(normalizeButtonLabels([3 as any, null as any, 'ok'])).toEqual(['ok']);
  });

  it('the tool schema accepts an optional list of labels and states the limits', () => {
    expect(buttonsSchema.parse(undefined)).toBeUndefined();
    expect(buttonsSchema.parse(['Yes', 'No'])).toEqual(['Yes', 'No']);
    const json = JSON.stringify(z.toJSONSchema(buttonsSchema));
    expect(json).toContain(`1-${MAX_BUTTONS}`);
    expect(json).toContain(`${MAX_LABEL_CHARS} chars`);
  });

  it('renders one button per label with unique action ids and the row id as value', () => {
    const block = buttonsActions({ id: 9, labels: ['ESP32', 'Pico', 'Arduino'] });
    expect(block).toMatchObject({ type: 'actions', block_id: 'reply_9_buttons' });
    expect(block.elements.map((e) => e.action_id)).toEqual([`${REPLY_CHOICE_ACTION}:0`, `${REPLY_CHOICE_ACTION}:1`, `${REPLY_CHOICE_ACTION}:2`]);
    expect(new Set(block.elements.map((e) => e.value))).toEqual(new Set(['9']));
    expect(block.elements.map((e) => e.text.text)).toEqual(['ESP32', 'Pico', 'Arduino']);
    const pressed = buttonsBlock({ id: 9, labels: ['ESP32', 'Pico'], pressedBy: 'U7', pressedLabel: 'Pi*co <x>' });
    expect(pressed).toEqual({ type: 'context', block_id: 'reply_9_pressed', elements: [{ type: 'mrkdwn', text: '<@U7> pressed *Pico &lt;x&gt;*' }] });
  });
});

describe('reply buttons: no-turn buttons', () => {
  it('objects carry what a press does: fixed_reply (no turn, posted), no_turn (just the note), or a turn', () => {
    const { labels, responses } = normalizeButtons(['Yes', { label: 'No thanks', fixed_reply: '  all good <!here> ' }, { label: 'Later', no_turn: true }, { label: 'Plain' }, { label: '' }, { no_turn: true }]);
    expect(labels).toEqual(['Yes', 'No thanks', 'Later', 'Plain']);
    expect(responses[0]).toBeNull();
    expect(responses[1]).toMatchObject({ kind: 'text' });
    expect((responses[1] as any).text).not.toContain('<!here>');
    expect(responses.slice(2)).toEqual([{ kind: 'none' }, null]);
    expect((normalizeButtons([{ label: 'x', fixed_reply: 'y'.repeat(MAX_FIXED_REPLY_CHARS + 50) }]).responses[0] as any).text).toHaveLength(MAX_FIXED_REPLY_CHARS);
    expect(normalizeButtonLabels(['a', { label: 'b', no_turn: true }])).toEqual(['a', 'b']);
  });

  it('no-turn buttons get the reply:quiet action id; rows without responses render as before', () => {
    const block = buttonsActions({ id: 3, labels: ['Yes', 'No thanks'], responses: [null, { kind: 'none' }] });
    expect(block.elements.map((e) => e.action_id)).toEqual([`${REPLY_CHOICE_ACTION}:0`, `${REPLY_QUIET_ACTION}:1`]);
    expect(buttonsActions({ id: 3, labels: ['Yes', 'No'], responses: null }).elements.map((e) => e.action_id)).toEqual([`${REPLY_CHOICE_ACTION}:0`, `${REPLY_CHOICE_ACTION}:1`]);
    expect(REPLY_CHOICE_ACTION.startsWith(REPLY_QUIET_ACTION) || REPLY_QUIET_ACTION.startsWith(REPLY_CHOICE_ACTION)).toBe(false);
  });

  it('stored responses parse leniently (unknown = a turn)', () => {
    expect(parseButtonResponse({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(parseButtonResponse({ kind: 'text', text: 'ok' })).toEqual({ kind: 'text', text: 'ok' });
    for (const v of [null, undefined, 'none', { kind: 'text', text: ' ' }, { kind: 'other' }]) expect(parseButtonResponse(v)).toBeNull();
  });

  it('the tool schema accepts labels and typed button objects and documents the types, place and who', () => {
    expect(
      buttonsSchema.parse(['Yes', { label: 'No thanks', type: 'text', text: 'all good' }, { label: 'Up', type: 'action', action: { tool: 'upload_emoji', args: { name: 'x', file_id: 'file_1' } }, done_text: 'done', place: 'append', who: 'requester' }]),
    ).toHaveLength(3);
    // Lenient: a missing or stringified args, nulls and older fields never fail the call.
    expect(() => buttonsSchema.parse([{ label: 'Up', type: 'action', action: { tool: 'upload_emoji' } }, { label: 'A', action: { tool: 't', args: '{"x":1}' }, place: null, who: null }, { label: 'No', fixed_reply: 'ok' }])).not.toThrow();
    expect((buttonsSchema.parse([{ label: 'No', fixed_reply: 'ok' }]) as any)[0].fixed_reply).toBe('ok');
    expect((normalizeButtons(buttonsSchema.parse([{ label: 'A', action: { tool: 't', args: '{"x":1}' } }]) as any).responses[0] as any).args).toBe('{"x":1}');
    const json = JSON.stringify(z.toJSONSchema(buttonsSchema));
    for (const word of ['prompt', 'none', 'action', 'append', 'replace', 'requester', 'done_text']) expect(json).toContain(word);
  });
});

describe('reply buttons: types', () => {
  it('infers the type, applies defaults and stores only what differs from a plain prompt button', () => {
    const { labels, responses, notes } = normalizeButtons([
      'Plain',
      { label: 'Prompt', type: 'prompt' },
      { label: 'Bigger', type: 'prompt', place: 'replace' },
      { label: 'Mine', who: 'requester' },
      { label: 'Ok', text: 'cool' },
    ]);
    expect(labels).toEqual(['Plain', 'Prompt', 'Bigger', 'Mine', 'Ok']);
    expect(responses).toEqual([null, null, { kind: 'prompt', place: 'replace' }, { kind: 'prompt', who: 'requester' }, { kind: 'text', text: 'cool' }]);
    expect(notes).toEqual([]);
    expect(normalizeButtons([{ label: 'Nothing', type: 'text' }]).responses).toEqual([{ kind: 'none' }]);
    const act = normalizeButtons([{ label: 'Up', action: { tool: 'upload_emoji', args: { name: 'x' } }, done_text: 'live <!here>' }]).responses[0] as any;
    expect(act).toMatchObject({ kind: 'action', tool: 'upload_emoji', args: '{"name":"x"}' });
    expect(act.done).not.toContain('<!here>');
    expect(buttonPlace(act)).toBe('append');
    expect(buttonWho(act)).toBe('requester');
    expect(buttonPlace({ kind: 'text', text: 'x' })).toBe('new');
    expect(buttonWho(null)).toBe('anyone');
    // An action without a tool: a prompt button, and the model hears why.
    const bad = normalizeButtons([{ label: 'Go', type: 'action' }, { label: 'Open', type: 'action', who: 'anyone' }]);
    expect(bad.responses).toEqual([{ kind: 'prompt', who: 'requester' }, null]);
    expect(bad.notes[0]).toContain('"Go"');
  });

  it('parses stored responses and outcomes, old and new', () => {
    expect(parseButtonResponse({ kind: 'prompt', place: 'append', who: 'requester' })).toEqual({ kind: 'prompt', place: 'append', who: 'requester' });
    expect(parseButtonResponse({ kind: 'action', tool: 't', args: '{}', done: 'ok', place: 'bogus' })).toEqual({ kind: 'action', tool: 't', args: '{}', done: 'ok' });
    expect(parseButtonResponse({ kind: 'action', tool: 't' })).toBeNull();
    expect(parseButtonOutcome({ ok: false, text: 'x' })).toEqual({ ok: false, text: 'x' });
    expect(parseButtonOutcome({ text: 'x' })).toBeNull();
  });

  it('prompt buttons (also with place / who) start turns; the rest go to reply:quiet', () => {
    const block = buttonsActions({ id: 4, labels: ['a', 'b', 'c'], responses: [{ kind: 'prompt', place: 'append' }, { kind: 'action', tool: 't', args: '{}' }, null] });
    expect(block.elements.map((e) => e.action_id)).toEqual([`${REPLY_CHOICE_ACTION}:0`, `${REPLY_QUIET_ACTION}:1`, `${REPLY_CHOICE_ACTION}:2`]);
  });

  it('the pressed note says how an action went; placeText appends or replaces', () => {
    const b = { id: 1, labels: ['Up'], responses: [{ kind: 'action' as const, tool: 't', args: '{}' }], pressedBy: 'U1', pressedLabel: 'Up' };
    expect(pressedText(b)).toBe('<@U1> pressed *Up* · working on it…');
    expect(pressedText({ ...b, outcome: { ok: true, text: '' } })).toBe('<@U1> pressed *Up* · done ✓');
    expect(pressedText({ ...b, outcome: { ok: false, text: '' } })).toBe("<@U1> pressed *Up* · didn't work");
    expect(pressedText({ ...b, responses: [null] })).toBe('<@U1> pressed *Up*');
    // Repeated labels: the stored index decides which button's response it was.
    const dup = { id: 1, labels: ['Up', 'Up'], responses: [null, { kind: 'action' as const, tool: 't', args: '{}' }], pressedBy: 'U1', pressedLabel: 'Up', outcome: { ok: true, text: '' } };
    expect(pressedText({ ...dup, pressedIndex: 1 })).toBe('<@U1> pressed *Up* · done ✓');
    expect(pressedText({ ...dup, pressedIndex: 0 })).toBe('<@U1> pressed *Up*');
    expect(placeText('here it is  ', 'done', 'append')).toBe('here it is\n\ndone');
    expect(placeText(null, 'done', 'append')).toBe('done');
    expect(placeText('here it is', 'done', 'replace')).toBe('done');
  });
});

describe('reply buttons: actions', () => {
  const ctx = { threadId: 'C1:1.1', channelId: 'C1', speakerId: 'U1' };
  const action = (tool: string, args: unknown) => ({ kind: 'action' as const, tool, args: JSON.stringify(args) });

  it('prepare keeps runnable actions and turns the rest into prompt buttons with a note', async () => {
    const { responses, notes } = await prepareButtonActions(
      ['ok', 'unknown', 'bad args', 'refused'],
      [action('unit_echo', { say: 'hi' }), action('nope', {}), action('unit_echo', { say: 3 }), { ...action('unit_echo', { say: 'no' }), who: 'requester' }],
      ctx,
    );
    const req = { kind: 'prompt', who: 'requester' };
    expect(responses).toEqual([action('unit_echo', { say: 'hi' }), req, req, req]);
    expect((await prepareButtonActions(['x'], [{ ...action('nope', {}), who: 'anyone' }], ctx)).responses).toEqual([null]);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('unit_echo');
    expect(notes[2]).toContain('not allowed');
  });

  it('run re-checks, runs, and turns throws into failed outcomes', async () => {
    expect(await runButtonAction(action('unit_echo', { say: 'hi' }), { ...ctx, key: '1' })).toEqual({ ok: true, text: 'said hi' });
    expect(await runButtonAction(action('unit_echo', { say: 'no' }), { ...ctx, key: '1' })).toEqual({ ok: false, text: 'not allowed' });
    expect((await runButtonAction(action('unit_echo', { say: 'boom' }), { ...ctx, key: '1' })).ok).toBe(false);
    expect((await runButtonAction(action('gone', {}), { ...ctx, key: '1' })).ok).toBe(false);
  });

  it('the failure notice quotes the error as untrusted data', () => {
    const notice = renderActionFailure({ presser: 'U1', label: 'Up "it"', tool: 'upload_emoji', error: 'name taken' });
    expect(notice).toContain('name taken');
    expect(notice).toContain('System notice (not a message from <@U1>)');
    expect(notice).toContain('upload_emoji');
  });
});

describe('reply buttons: delivery', () => {
  it('a posted reply carries the actions block right after the markdown', async () => {
    const rm = new ReplyManager(target('synthesis'));
    const res = await rm.finish('tc1', 'which one?', undefined, ['ESP32', 'Pico']);
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'actions']);
    expect(post.args.blocks[1].elements.map((e: any) => e.text.text)).toEqual(['ESP32', 'Pico']);
    expect(recorded).toEqual([{ id: 42, ts: expect.any(String), text: 'which one?' }]);
    expect(res).toContain('with buttons: ESP32 | Pico');
  });

  it('no buttons → no actions block and no row', async () => {
    const rm = new ReplyManager(target('synthesis'));
    await rm.finish('tc1', 'plain answer');
    expect(actionsOf(calls.find((c) => c.method === 'chat.postMessage')!.args.blocks)).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it('a streamed reply gets its buttons as chat.stopStream blocks', async () => {
    const rm = new ReplyManager(target('user'));
    rm.delta('tc1', '{"text":"want me to dig deeper into this one');
    await sleep(120);
    await rm.finish('tc1', 'want me to dig deeper into this one?', undefined, ['Yes', 'No']);
    expect(calls.some((c) => c.method === 'chat.startStream')).toBe(true);
    const stop = calls.find((c) => c.method === 'chat.stopStream')!;
    expect(actionsOf(stop.args.blocks)).toHaveLength(1);
    expect(calls.some((c) => c.method === 'chat.update' || c.method === 'chat.postMessage')).toBe(false);
    expect(recorded).toEqual([{ id: 42, ts: '1700000000.000900', text: 'want me to dig deeper into this one?' }]);
  });

  it('stopStream refusing the blocks → stopped plainly, buttons added via chat.update', async () => {
    failOn = (m, a) => m === 'chat.stopStream' && Boolean(a.blocks);
    const rm = new ReplyManager(target('user'));
    rm.delta('tc1', '{"text":"want me to dig deeper into this one');
    await sleep(120);
    await rm.finish('tc1', 'want me to dig deeper into this one?', undefined, ['Yes', 'No']);
    const stops = calls.filter((c) => c.method === 'chat.stopStream');
    expect(stops).toHaveLength(2);
    expect(stops[1]!.args.blocks).toBeUndefined();
    const upd = calls.find((c) => c.method === 'chat.update')!;
    expect(upd.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'actions']);
    expect(upd.args.blocks[0].text).toBe('want me to dig deeper into this one?');
    expect(recorded).toEqual([{ id: 42, ts: '1700000000.000900', text: 'want me to dig deeper into this one?' }]);
  });

  it('chat.update failing too → buttons posted as a small follow-up message', async () => {
    failOn = (m, a) => (m === 'chat.stopStream' && Boolean(a.blocks)) || m === 'chat.update';
    const rm = new ReplyManager(target('user'));
    rm.delta('tc1', '{"text":"want me to dig deeper into this one');
    await sleep(120);
    await rm.finish('tc1', 'want me to dig deeper into this one?', undefined, ['Yes', 'No']);
    const follow = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(follow.args.blocks.map((b: any) => b.type)).toEqual(['actions']);
    expect(follow.args.text).toBe('Options: Yes | No');
    expect(recorded).toEqual([{ id: 42, ts: expect.any(String), text: null }]);
  });
});

describe('reply buttons: plan card re-render', () => {
  const run = { id: 1, subagentTitle: 'Research', status: 'running' as const, isResume: false, details: null, steerNotes: [], output: null, error: null };
  it('a card living in a reply keeps its buttons, then the pressed note, with stable block ids', () => {
    const open = renderCard({ id: 3, title: null, frozen: false, replyText: 'which one?', buttons: { id: 9, labels: ['A', 'B'] } }, [run]);
    expect(open.blocks.map((b) => b.type)).toEqual(['plan', 'markdown', 'actions']);
    expect(open.blocks[2]).toMatchObject({ block_id: 'reply_9_buttons' });
    const pressed = renderCard({ id: 3, title: null, frozen: false, replyText: 'which one?', buttons: { id: 9, labels: ['A', 'B'], pressedBy: 'U2', pressedLabel: 'B' } }, [run]);
    expect(pressed.blocks.map((b) => b.type)).toEqual(['plan', 'markdown', 'context']);
    expect(JSON.stringify(pressed.blocks[2])).toContain('<@U2> pressed *B*');
    expect(pressed.blocks[1]).toMatchObject({ block_id: 'card_3_reply' });
    expect(pressed.blocks[0]).toMatchObject({ block_id: 'card_3_plan' });
    // Replies without buttons: just the card and the reply.
    expect(renderCard({ id: 3, title: null, frozen: false, replyText: 'hi' }, [run]).blocks.map((b) => b.type)).toEqual(['plan', 'markdown']);
  });
});

describe('reply buttons: placing a reply into a pressed button\'s message', () => {
  it('the first reply is appended into that message by chat.update; the next one posts as usual', async () => {
    placedRow = { id: 7, channelId: 'C1', messageTs: '1700000000.000500', replyText: 'here it is\n[[chart:1]]' };
    const delivered: any[] = [];
    const rm = new ReplyManager({ ...target('user'), triggerTs: '1700000000.000900', onDelivered: async (r: any) => void delivered.push(r), placeTarget: { ts: '1700000000.000500', buttonsId: 7, place: 'append' } });
    rm.delta('tc1', '{"text":"bigger now');
    await sleep(50);
    const res = await rm.finish('tc1', 'bigger now', undefined, ['Again']);
    expect(calls.some((c) => c.method.startsWith('chat.startStream'))).toBe(false);
    expect(calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
    const upd = calls.find((c) => c.method === 'chat.update' && c.args.ts === '1700000000.000500')!;
    expect(upd.args.text).toContain('here it is');
    expect(upd.args.text).not.toContain('[[chart');
    expect(upd.args.text).toContain('bigger now');
    expect(actionsOf(upd.args.blocks)).toHaveLength(1);
    expect(detached).toEqual(['1700000000.000500']);
    expect(recorded.at(-1)).toMatchObject({ ts: '1700000000.000500', text: expect.stringContaining('bigger now') });
    expect(res).toContain('Replied (posted)');
    // The thread's "last bot reply" is the press, not the old message's ts.
    expect(delivered[0].ts).toBe('1700000000.000900');
    await rm.finish('tc2', 'one more thing');
    expect(calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
  });

  it('the place goes to the first reply actually delivered, never to one with files or one a retry already posted', async () => {
    placedRow = { id: 7, channelId: 'C1', messageTs: '1700000000.000500', replyText: 'old', labels: ['Go'], pressedBy: 'U1', pressedLabel: 'Go' };
    const place = { ts: '1700000000.000500', buttonsId: 7, place: 'replace' as const };
    const rm = new ReplyManager({ ...target('user'), placeTarget: place });
    expect(await rm.finish('tc1', '   ')).toContain('Not posted');
    await rm.finish('tc2', 'second');
    const upd = calls.find((c) => c.method === 'chat.update' && c.args.ts === place.ts)!;
    expect(upd.args.text).toBe('second');
    // No new buttons: the press's note stays in the message.
    expect(upd.args.blocks.at(-1)).toMatchObject({ type: 'context', block_id: 'reply_7_pressed' });

    calls.length = 0;
    posted = true;
    await new ReplyManager({ ...target('user'), placeTarget: place }).finish('tc1', 'retried');
    expect(calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args.text)).toEqual(['retried']);
  });

  it('replace swaps the text; a message that can\'t take it gets a new post instead', async () => {
    placedRow = { id: 7, channelId: 'C1', messageTs: '1700000000.000500', replyText: 'old', labels: ['Go'], pressedBy: 'U1', pressedLabel: 'Go' };
    const rm = new ReplyManager({ ...target('user'), placeTarget: { ts: '1700000000.000500', buttonsId: 7, place: 'replace' } });
    await rm.finish('tc1', 'new');
    expect(calls.find((c) => c.method === 'chat.update')!.args.text).toBe('new');

    calls.length = 0;
    failOn = (m, a) => m === 'chat.update' && a.ts === '1700000000.000500';
    const rm2 = new ReplyManager({ ...target('user'), placeTarget: { ts: '1700000000.000500', buttonsId: 7, place: 'replace' } });
    await rm2.finish('tc1', 'fallback');
    expect(calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args.text)).toEqual(['fallback']);
  });
});

describe('reply buttons: context rendering', () => {
  it('names what action buttons run and how the press went', () => {
    const env = { names: new Map([['U1', 'Ingo']]), self: { userId: 'UBOT', botId: 'BBOT', name: 'Smasnug' }, maxChars: 2000 };
    const base = { userId: 'UBOT', botId: 'BBOT', username: null, files: [], ts: '1.2', text: 'here' };
    expect(formatMessage({ ...base, buttons: { labels: ['Up', 'No'], actions: ['upload_emoji', null] } }, env)).toBe('[1.2] [bot] Smasnug (you): here [buttons: Up (runs upload_emoji) | No]');
    expect(formatMessage({ ...base, buttons: { labels: ['Up'], actions: ['upload_emoji'], pressedBy: 'U1', pressedLabel: 'Up', outcome: { ok: true, text: 'Added :x:' } } }, env)).toBe(
      '[1.2] [bot] Smasnug (you): here [buttons: Up (runs upload_emoji); <@U1|Ingo> pressed "Up" → done: Added :x:]',
    );
    expect(formatMessage({ ...base, buttons: { labels: ['Up'], actions: ['upload_emoji'], pressedBy: 'U1', pressedLabel: 'Up', outcome: { ok: false, text: '<injected>' } } }, env)).toBe(
      '[1.2] [bot] Smasnug (you): here [buttons: Up (runs upload_emoji); <@U1|Ingo> pressed "Up" → failed]',
    );
  });

  const env = { names: new Map([['U1', 'Ingo']]), self: { userId: 'UBOT', botId: 'BBOT', name: 'Smasnug' }, maxChars: 2000 };
  it('shows offered buttons on the bot message and marks the press', () => {
    const base = { userId: 'UBOT', botId: 'BBOT', username: null, files: [] };
    expect(formatMessage({ ...base, ts: '1.2', text: 'which board?', buttons: { labels: ['ESP32', 'Pico'] } }, env)).toBe('[1.2] [bot] Smasnug (you): which board? [buttons: ESP32 | Pico]');
    expect(formatMessage({ ...base, ts: '1.2', text: 'which board?', buttons: { labels: ['ESP32', 'Pico'], pressedBy: 'U1', pressedLabel: 'Pico' } }, env)).toBe(
      '[1.2] [bot] Smasnug (you): which board? [buttons: ESP32 | Pico; <@U1|Ingo> pressed "Pico"]',
    );
    expect(formatMessage({ ts: '1.3', userId: 'U1', botId: null, username: null, files: [], text: 'Pico', viaButton: true }, env)).toBe('[1.3] <@U1|Ingo>: Pico (button)');
  });
});
