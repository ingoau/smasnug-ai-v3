/**
 * Front turn with a mock language model (no network, no DB): reply streaming from tool-input deltas, delivery
 * mode, fallback, discarded text, phase and inbox injection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test-key';
  process.env.LOG_LEVEL = 'silent';
});

const h = vi.hoisted(() => ({
  slack: [] as { method: string; args: any }[],
  events: [] as { type: string; payload: any }[],
  activeRuns: 0,
  model: undefined as any,
}));

vi.mock('../db/index.js', () => {
  const sql: any = async () => [];
  sql.json = (v: unknown) => v;
  sql.begin = async (fn: any) => fn(sql);
  return { sql };
});
vi.mock('../core/redis.js', () => ({ redis: {}, bullConnection: () => ({}) }));
vi.mock('../core/slack.js', () => ({
  slackCall: async (method: string, args: any) => {
    h.slack.push({ method, args });
    if (method === 'auth.test') return { ok: true, team_id: 'T1' };
    if (method === 'users.info') return { ok: true, user: { real_name: 'Tess', tz: 'Europe/Berlin' } };
    return { ok: true, ts: '200.000001' };
  },
}));
vi.mock('../core/events.js', async (orig) => ({
  ...(await orig<typeof import('../core/events.js')>()),
  appendEvent: async (_t: string, type: string, _a: string, payload: any) => {
    h.events.push({ type, payload });
  },
}));
vi.mock('./subagents.js', () => ({ activeRunsInThread: async () => h.activeRuns }));
vi.mock('./cards.js', () => ({ postCard: async () => {}, freezeCard: async () => {}, scheduleCardRender: async () => {} }));
vi.mock('../context/thread.js', () => ({
  renderThreadContext: async () => ({ history: '<@U1> Tess: earlier', channelContext: '', newMessages: '<@U1> Tess: hi bot' }),
  renderMessages: async (_t: string, ts: string[]) => `<@U1> Tess: INBOX ${ts.join(',')}`,
}));
vi.mock('../models.js', () => ({
  MODELS: { gate: 'm', front: 'm', child: 'm', childHard: 'm' },
  openrouter: () => h.model,
}));

const { MockLanguageModelV4 } = await import('ai/test');
const { simulateReadableStream } = await import('ai');
await import('./tools.js');
const { runFrontTurn } = await import('./front.js');

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function replyStep(text: string, chunkSize = 7) {
  const json = JSON.stringify({ text });
  const deltas: any[] = [];
  for (let i = 0; i < json.length; i += chunkSize) deltas.push({ type: 'tool-input-delta', id: 'c1', delta: json.slice(i, i + chunkSize) });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'c1', toolName: 'reply' },
    ...deltas,
    { type: 'tool-input-end', id: 'c1' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'reply', input: json },
    { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
  ];
}
const textStep = (text: string) => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
];

function mockModel(steps: any[][], chunkDelayInMs = 0) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: steps[Math.min(i++, steps.length - 1)]!, chunkDelayInMs }) as any }),
  });
}

const turn = (over: any = {}) => ({
  id: 7 as any,
  threadId: 'C1:100.000001',
  authorId: 'U1',
  kind: 'user' as const,
  isMention: true,
  messageTs: ['100.000002'],
  cardId: null,
  status: 'running' as const,
  phase: null,
  ...over,
});

function io(isMention = true, inbox: any[][] = []) {
  const phases: string[] = [];
  let n = 0;
  return { phases, io: { isMention, drainInbox: async () => inbox[n++] ?? [], setPhase: async (p: 'tools' | 'final') => void phases.push(p) } };
}

beforeEach(() => {
  h.slack = [];
  h.events = [];
  h.activeRuns = 0;
});

describe('runFrontTurn (mock model)', () => {
  it('streams the reply live from tool-input deltas when no runs are active', async () => {
    const text = 'Hello **there**!\nHere is a "quoted" line with a backslash \\ and ünïcode.';
    h.model = mockModel([replyStep(text, 5), textStep('done')], 40);
    const { io: tio, phases } = io();
    await runFrontTurn(turn(), tio);
    const methods = h.slack.map((c) => c.method).filter((m) => m.startsWith('chat.'));
    expect(methods[0]).toBe('chat.startStream');
    expect(methods).toContain('chat.appendStream');
    expect(methods.at(-1)).toBe('chat.stopStream');
    const streamed = h.slack.filter((c) => c.method === 'chat.startStream' || c.method === 'chat.appendStream').map((c) => c.args.markdown_text).join('');
    expect(streamed).toBe(text);
    const start = h.slack.find((c) => c.method === 'chat.startStream')!;
    expect(start.args).toMatchObject({ channel: 'C1', thread_ts: '100.000001', recipient_user_id: 'U1', recipient_team_id: 'T1' });
    expect(phases).toEqual(['final']);
    expect(h.events.find((e) => e.type === 'reply')?.payload).toMatchObject({ mode: 'streamed', text, index: 0 });
    expect(h.events.find((e) => e.type === 'discarded_text')?.payload.text).toBe('done');
  });

  it('posts the reply whole with a markdown block while runs are active', async () => {
    h.activeRuns = 2;
    h.model = mockModel([replyStep('Noted, adding that.'), textStep('')]);
    await runFrontTurn(turn(), io().io);
    const chat = h.slack.filter((c) => c.method.startsWith('chat.'));
    expect(chat).toHaveLength(1);
    expect(chat[0]!.method).toBe('chat.postMessage');
    expect(chat[0]!.args).toMatchObject({ text: 'Noted, adding that.', thread_ts: '100.000001', blocks: [{ type: 'markdown', text: 'Noted, adding that.' }] });
  });

  it('posts a fallback for a mention with nothing visible, but not for an unmentioned follow-up', async () => {
    h.model = mockModel([textStep('I think I should say something')]);
    await runFrontTurn(turn(), io(true).io);
    expect(h.slack.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    h.slack = [];
    h.model = mockModel([textStep('nothing to add')]);
    await runFrontTurn(turn({ id: 8, isMention: false }), io(false).io);
    expect(h.slack.filter((c) => c.method.startsWith('chat.'))).toHaveLength(0);
  });

  it('injects inbox messages before the next model call and updates defaultReactTs', async () => {
    h.model = mockModel([replyStep('first'), textStep('')]);
    const msg = { ts: '100.000009', text: 'one more thing', channelId: 'C1' } as any;
    await runFrontTurn(turn(), io(true, [[], [msg]]).io);
    const calls = (h.model as any).doStreamCalls as any[];
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0].prompt)).not.toContain('INBOX');
    expect(JSON.stringify(calls[1].prompt)).toContain('INBOX 100.000009');
    expect(h.events.some((e) => e.type === 'inbox_injected')).toBe(true);
  });

  it('closes an open stream itself when the model fails mid-turn, and throws when nothing was visible', async () => {
    const failing = [...replyStep('partial answer that is long enough').slice(0, -2), { type: 'error', error: new Error('boom') }];
    h.model = mockModel([failing], 120);
    await expect(runFrontTurn(turn(), io().io)).resolves.toBeUndefined();
    const stop = h.slack.find((c) => c.method === 'chat.stopStream');
    expect(stop?.args.markdown_text).toContain('Something broke');

    h.slack = [];
    h.model = mockModel([[{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error('down') }]]);
    await expect(runFrontTurn(turn({ id: 9 }), io().io)).rejects.toThrow();
    expect(h.slack.filter((c) => c.method.startsWith('chat.'))).toHaveLength(0);
  });
});
