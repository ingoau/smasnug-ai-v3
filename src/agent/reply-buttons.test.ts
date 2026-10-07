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
vi.mock('../core/events.js', () => ({ appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}) }));
const recorded: { id: number; ts: string; text: string | null }[] = [];
vi.mock('./reply-buttons-store.js', () => ({
  createReplyButtons: vi.fn(async (o: any) => ({ id: 42, threadId: o.threadId, channelId: o.channelId, turnId: o.turnId, messageTs: null, replyText: null, labels: o.labels, pressedBy: null, pressedLabel: null, pressedMessageTs: null, pressedAt: null })),
  setButtonsMessage: vi.fn(async (id: number, ts: string, text: string | null) => void recorded.push({ id, ts, text })),
  toButtonsState: (r: any) => ({ id: r.id, labels: r.labels, pressedBy: r.pressedBy, pressedLabel: r.pressedLabel }),
}));

const { ReplyManager } = await import('./reply.js');
const { MAX_BUTTONS, MAX_LABEL_CHARS, SLACK_BUTTON_TEXT_MAX, REPLY_CHOICE_ACTION, buttonsActions, buttonsBlock, normalizeButtonLabels } = await import('./reply-buttons.js');
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
  failOn = null;
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

describe('reply buttons: context rendering', () => {
  const env = { names: new Map([['U1', 'Ingo']]), self: { userId: 'UBOT', botId: 'BBOT', name: 'Smasnug' }, maxChars: 2000 };
  it('shows offered buttons on the bot message and marks the press', () => {
    const base = { userId: 'UBOT', botId: 'BBOT', username: null, files: [] };
    expect(formatMessage({ ...base, ts: '1.2', text: 'which board?', buttons: { labels: ['ESP32', 'Pico'] } }, env)).toBe('[1.2] [bot] Smasnug (you): which board? [buttons: ESP32 | Pico]');
    expect(formatMessage({ ...base, ts: '1.2', text: 'which board?', buttons: { labels: ['ESP32', 'Pico'], pressedBy: 'U1', pressedLabel: 'Pico' } }, env)).toBe(
      '[1.2] [bot] Smasnug (you): which board? [buttons: ESP32 | Pico; Ingo pressed "Pico"]',
    );
    expect(formatMessage({ ts: '1.3', userId: 'U1', botId: null, username: null, files: [], text: 'Pico', viaButton: true }, env)).toBe('[1.3] <@U1> Ingo: Pico (button)');
  });
});
