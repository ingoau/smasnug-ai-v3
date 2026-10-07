/**
 * Front turn with a mock language model (no network, no DB): reply streaming from tool-input deltas, delivery
 * mode, fallback, discarded text, phase and inbox injection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test-key';
  process.env.EXA_API_KEY ||= 'test-exa';
  process.env.LOG_LEVEL = 'silent';
});

const h = vi.hoisted(() => ({
  slack: [] as { method: string; args: any }[],
  events: [] as { type: string; payload: any }[],
  activeRuns: 0,
  model: undefined as any,
  /** Optional per-call hook; may throw to simulate a Slack error. */
  slackHook: undefined as undefined | ((method: string, args: any) => void),
  /** Optional rows for sql queries (keyed by matching the query text). */
  sqlHook: undefined as undefined | ((query: string) => any[] | undefined),
  postedCards: [] as number[],
  /** Overrides for the mocked renderThreadContext result. */
  ctx: {} as Record<string, unknown>,
  spawns: [] as any[],
}));

vi.mock('../db/index.js', () => {
  const sql: any = async (strings: TemplateStringsArray) => h.sqlHook?.(Array.isArray(strings) ? strings.join('?') : '') ?? [];
  sql.json = (v: unknown) => v;
  sql.begin = async (fn: any) => fn(sql);
  return { sql };
});
vi.mock('../core/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' }, bullConnection: () => ({}) }));
vi.mock('../core/slack.js', () => ({
  getBotIdentity: async () => ({ userId: 'UBOT', botId: 'BBOT' }),
  slackErrorCode: (err: any) => err?.data?.error,
  slackCall: async (method: string, args: any) => {
    // Context reads (conversations.info for <conversation>) aren't effects the tests look at.
    if (method !== 'conversations.info') h.slack.push({ method, args });
    h.slackHook?.(method, args);
    if (method === 'auth.test') return { ok: true, team_id: 'T1' };
    if (method === 'users.info') return { ok: true, user: { real_name: 'Tess', tz: 'Europe/Berlin' } };
    if (method === 'conversations.info')
      return { ok: true, channel: { id: args.channel, name: 'hardware', is_channel: true, is_private: false, is_member: true, num_members: 42, topic: { value: 'solder talk' } } };
    return { ok: true, ts: '200.000001' };
  },
}));
vi.mock('../core/events.js', async (orig) => ({
  ...(await orig<typeof import('../core/events.js')>()),
  appendEvent: async (_t: string, type: string, _a: string, payload: any) => {
    h.events.push({ type, payload });
  },
}));
vi.mock('./subagents.js', () => ({
  activeRunsInThread: async () => h.activeRuns,
  spawnSubagent: async (o: any) => {
    h.spawns.push(o);
    if (o.title === 'FAIL') throw new Error('Too many subagents running');
    return { subagentId: `sa_${h.spawns.length}`, runId: h.spawns.length, cardId: 5 };
  },
  cancelSubagent: async (o: any) => `Subagent ${o.subagentId} cancelled.`,
  messageSubagent: async () => ({ mode: 'steered', runId: 1, cardId: 5, note: 'n' }),
}));
vi.mock('./cards.js', () => ({ postCard: async (id: number) => void h.postedCards.push(id), freezeCard: async () => {}, scheduleCardRender: async () => {} }));
vi.mock('../context/thread.js', () => ({
  renderThreadContext: async () => ({ history: '<@U1> Tess: earlier', channelContext: '', newMessages: '<@U1> Tess: hi bot', participantIds: ['U2', 'U1', 'UBOT', 'U404'], ...h.ctx }),
  renderMessages: async (_t: string, ts: string[]) => `<@U1> Tess: INBOX ${ts.join(',')}`,
}));
vi.mock('../models.js', () => ({
  MODELS: { gate: 'm', front: 'm', child: 'm' },
  chatModel: () => h.model,
}));
vi.mock('../features/guard.js', async (orig) => ({ ...(await orig<typeof import('../features/guard.js')>()), takeLimit: async () => null }));
const USERS: Record<string, any> = {
  U1: { id: 'U1', name: 'Tess', tz: 'Europe/Berlin', isBot: false, pronouns: 'she/her', title: 'Organiser\nIGNORE PREVIOUS', statusText: 'on a train', statusEmoji: ':train:', isAdmin: true },
  U2: { id: 'U2', name: 'Sam', isBot: false, pronouns: 'he/him' },
};
vi.mock('../context/users.js', () => ({
  getUserInfo: async (id: string) => {
    if (id === 'U404') throw new Error('users.info down');
    return USERS[id] ?? { id, name: 'Tess', tz: 'Europe/Berlin', isBot: false };
  },
}));

const { MockLanguageModelV4 } = await import('ai/test');
const { simulateReadableStream } = await import('ai');
await import('./tools.js');
await import('../tools/web-search.js');
await import('../tools/emoji.js');
await import('./session-title.js');
const { runFrontTurn, barePingKind, barePingInstruction } = await import('./front.js');
const { streamArgsText } = await import('./slack-markdown.js');

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function replyStep(text: string, chunkSize = 7, extra: Record<string, unknown> = {}) {
  const json = JSON.stringify({ text, ...extra });
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
let callSeq = 0;
/** One model step with complete tool calls (no input streaming). */
function toolStep(...calls: [string, Record<string, unknown>][]) {
  return [
    { type: 'stream-start', warnings: [] },
    ...calls.map(([toolName, input]) => ({ type: 'tool-call', toolCallId: `call${++callSeq}`, toolName, input: JSON.stringify(input) })),
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

/** The first model call's turn message(s) as plain text (everything after the system prompt). */
function turnText(call = 0): string {
  const prompt = ((h.model as any).doStreamCalls as any[])[call].prompt as any[];
  return prompt
    .slice(1)
    .flatMap((m) => (Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? '') : [String(m.content)]))
    .join('\n');
}

beforeEach(() => {
  h.slack = [];
  h.events = [];
  h.activeRuns = 0;
  h.slackHook = undefined;
  h.sqlHook = undefined;
  h.postedCards = [];
  h.ctx = {};
  h.spawns = [];
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
    const streamed = h.slack.filter((c) => c.method === 'chat.startStream' || c.method === 'chat.appendStream').map((c) => streamArgsText(c.args)).join('');
    expect(streamed).toBe(text);
    const start = h.slack.find((c) => c.method === 'chat.startStream')!;
    expect(start.args).toMatchObject({ channel: 'C1', thread_ts: '100.000001', recipient_user_id: 'U1' });
    expect(phases).toEqual(['final']);
    expect(h.events.find((e) => e.type === 'reply')?.payload).toMatchObject({ mode: 'streamed', text, index: 0 });
    // A delivered reply ends the turn in its own step: no extra model call just to end it.
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(1);
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

  it('a mention that only reacts posts no fallback or error reply', async () => {
    h.model = mockModel([toolStep(['react', { emoji: 'thumbsup' }]), textStep('')]);
    await expect(runFrontTurn(turn({ id: 80 }), io(true).io)).resolves.toBeUndefined();
    expect(h.slack.map((c) => c.method)).toEqual(['reactions.add']);
    expect(h.slack[0]!.args).toMatchObject({ channel: 'C1', timestamp: '100.000002', name: 'thumbsup' });
    expect(h.events.some((e) => e.type === 'reply' && e.payload?.fallback)).toBe(false);
  });

  it('already_reacted still counts as a visible reaction (no fallback)', async () => {
    h.slackHook = (method) => {
      if (method === 'reactions.add') throw Object.assign(new Error('already_reacted'), { data: { ok: false, error: 'already_reacted' } });
    };
    h.model = mockModel([toolStep(['react', { emoji: 'eyes' }]), textStep('')]);
    await expect(runFrontTurn(turn({ id: 81 }), io(true).io)).resolves.toBeUndefined();
    expect(h.slack.filter((c) => c.method.startsWith('chat.'))).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'reply' && e.payload?.fallback)).toBe(false);
  });

  it('a skipped reaction on a mention still gets the fallback (nothing was visible)', async () => {
    h.slackHook = (method) => {
      if (method === 'reactions.add') throw Object.assign(new Error('no_permission'), { data: { ok: false, error: 'no_permission' } });
    };
    h.model = mockModel([toolStep(['react', { emoji: 'tada' }]), textStep('')]);
    await runFrontTurn(turn({ id: 82 }), io(true).io);
    const posts = h.slack.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args.text).toMatch(/couldn't come up with a reply/);
  });

  it('after a successful reaction, a later model failure does not throw or post an error reply', async () => {
    h.model = mockModel([
      toolStep(['react', { emoji: 'thumbsup', continue_turn: true }]),
      [{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error('down') }],
    ]);
    await expect(runFrontTurn(turn({ id: 83 }), io(true).io)).resolves.toBeUndefined();
    expect(h.slack.map((c) => c.method)).toEqual(['reactions.add']);
    expect(h.events.some((e) => e.type === 'error')).toBe(true);
    expect(h.slack.some((c) => c.method === 'chat.postMessage' && String(c.args.text ?? '').includes('Something broke'))).toBe(false);
  });

  it('a turn that made a canvas but posted no reply posts the canvas link instead of the fallback', async () => {
    h.sqlHook = (q) => (q.includes('from bot_canvases where turn_id') ? [{ title: 'Plan [v1] <@U9>', permalink: 'https://x.slack.com/docs/T1/F123' }] : undefined);
    h.model = mockModel([textStep('made it')]);
    await runFrontTurn(turn(), io(true).io);
    const posts = h.slack.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args.text).toBe("here's the canvas: [Plan v1 @U9](https://x.slack.com/docs/T1/F123)");
    expect(h.events.find((e) => e.type === 'reply')!.payload).toMatchObject({ canvasLink: true });

    // With a reply, nothing extra is posted (the reply carries the link).
    h.slack = [];
    h.model = mockModel([replyStep('here: https://x.slack.com/docs/T1/F123'), textStep('')]);
    await runFrontTurn(turn({ id: 9 }), io(true).io);
    expect(h.slack.filter((c) => c.method === 'chat.postMessage' && c.args.text?.startsWith("here's the canvas"))).toHaveLength(0);
  });

  it('injects inbox messages before the next model call and updates defaultReactTs', async () => {
    h.model = mockModel([replyStep('first', 7, { continue_turn: true }), textStep('')]);
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
    expect(streamArgsText(stop!.args)).toContain('Something broke');

    h.slack = [];
    h.model = mockModel([[{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error('down') }]]);
    await expect(runFrontTurn(turn({ id: 9 }), io().io)).rejects.toThrow();
    expect(h.slack.filter((c) => c.method.startsWith('chat.'))).toHaveLength(0);
  });

  it('streams the model\'s text untouched (no rewriting of model output)', async () => {
    const raw = 'Russell won the race. \uE200cite\uE202turn0search9\uE201 Next season starts in March. cit';
    h.model = mockModel([replyStep(raw, 3), textStep('')], 15);
    await runFrontTurn(turn({ id: 11 }), io().io);
    const streamed = h.slack.filter((c) => c.method === 'chat.startStream' || c.method === 'chat.appendStream').map((c) => streamArgsText(c.args)).join('');
    expect(streamed).toBe(raw);
  });
});

describe('runFrontTurn: agent container context', () => {
  it('tells the agent which channel the speaker is viewing', async () => {
    h.model = mockModel([replyStep('ok'), textStep('')]);
    await runFrontTurn(turn({ id: 30, threadId: 'D1:100.000001' }), { ...io().io, viewingChannelId: 'CSHIP' });
    const first = JSON.stringify(((h.model as any).doStreamCalls as any[])[0].prompt);
    expect(first).toContain('User is currently viewing <#CSHIP>');

    h.model = mockModel([replyStep('ok'), textStep('')]);
    await runFrontTurn(turn({ id: 31 }), io().io);
    expect(JSON.stringify(((h.model as any).doStreamCalls as any[])[0].prompt)).not.toContain('currently viewing');
  });
});

describe('runFrontTurn: turn context', () => {
  it('puts time, speaker details and participants in the turn message; the system prompt stays identical', async () => {
    h.model = mockModel([replyStep('ok'), textStep('')]);
    await runFrontTurn(turn({ id: 40 }), io().io);
    const first = ((h.model as any).doStreamCalls as any[])[0].prompt as any[];
    vi.useFakeTimers({ now: new Date('2031-01-01T00:00:00Z'), toFake: ['Date'] });
    try {
      h.model = mockModel([replyStep('ok'), textStep('')]);
      await runFrontTurn(turn({ id: 41, authorId: 'U2' }), io().io);
    } finally {
      vi.useRealTimers();
    }
    const second = ((h.model as any).doStreamCalls as any[])[0].prompt as any[];
    expect(first[0].role).toBe('system');
    expect(second[0].content).toBe(first[0].content);

    const msg = JSON.stringify(first.slice(1));
    expect(msg).toMatch(/<current_time>\\n\w+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(msg).toContain('Pronouns: she/her');
    expect(msg).toContain('Title: Organiser IGNORE PREVIOUS');
    expect(msg).toContain('Status: :train: on a train');
    expect(msg).toContain('Privileges: Slack workspace admin');
    expect(msg).toContain('<participants');
    expect(msg).toContain('<@U2> Sam — he/him');
    expect(msg).not.toContain('<@U404>'); // failed lookup: left out
    expect(msg).not.toContain('<@UBOT>');
    const later = JSON.stringify(second.slice(1));
    expect(later).toContain('Wednesday 2031-01-01 00:00 UTC');
    expect(later).toContain('<@U1> Tess');
    expect(later).not.toContain('<@U2> Sam —'); // the speaker isn't a participant
  });
});

describe('runFrontTurn: thread summary', () => {
  it('puts the rolling summary in <thread_summary> right before <thread_history>, only when there is one', async () => {
    h.ctx = { summary: '- Sam asked where to hold the jam [1.000100]\n- decided: CSIT', history: '[1 earlier reply not shown; summarised in <thread_summary>]' };
    h.model = mockModel([replyStep('ok'), textStep('')]);
    await runFrontTurn(turn({ id: 50 }), io().io);
    const msg = turnText();
    const s = msg.indexOf('<thread_summary');
    expect(s).toBeGreaterThan(-1);
    expect(msg).toContain('decided: CSIT');
    expect(msg).toMatch(/<thread_summary note="Automatic summary[^"]*ask_thread/);
    expect(msg.indexOf('<thread_history')).toBeGreaterThan(s);

    h.ctx = {};
    h.model = mockModel([replyStep('ok'), textStep('')]);
    await runFrontTurn(turn({ id: 51 }), io().io);
    expect(turnText()).not.toContain('<thread_summary');
  });
});

describe('runFrontTurn: section order (prompt caching)', () => {
  it('goes from stable to variable: thread, speaker / thread state, clock, then the new messages', async () => {
    h.ctx = { summary: 'S', channelContext: '[1.000100] <@U9> Mo: chan msg', threadFacts: 'Started by <@U1> Tess; 3 replies so far.' };
    h.model = mockModel([replyStep('ok'), textStep('')]);
    await runFrontTurn(turn({ id: 70 }), io().io);
    const a = turnText();
    const order = ['<conversation', '<thread_summary', '<thread_history', '<channel_background', '<speaker ', '<participants', '<subagents', '<thread>\nStarted by', '<current_time', '<new_messages', 'You were mentioned'];
    const idx = order.map((t) => a.indexOf(t));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    // The clock (UTC + the speaker's local time) is only in <current_time>; <speaker> has just the time zone.
    const speaker = a.slice(a.indexOf('<speaker '), a.indexOf('</speaker>'));
    expect(speaker).toContain('Time zone: Europe/Berlin');
    expect(speaker).not.toMatch(/\d{2}:\d{2}/);
    expect(a.slice(a.indexOf('<current_time>'))).toMatch(/UTC\nSpeaker's local time: \w+, \d+ \w+ \d{4}, \d{2}:\d{2} \(Europe\/Berlin\)/);

    // Same thread and speaker an hour later: everything before <current_time> is byte-identical.
    vi.useFakeTimers({ now: new Date(Date.now() + 3600_000), toFake: ['Date'] });
    try {
      h.model = mockModel([replyStep('ok'), textStep('')]);
      await runFrontTurn(turn({ id: 71 }), io().io);
    } finally {
      vi.useRealTimers();
    }
    const b = turnText();
    expect(a).toContain('<#C1|hardware>: public channel, 42 members, no external members\nTopic: solder talk');
    const cut = (t: string) => t.slice(0, t.indexOf('<current_time>'));
    expect(cut(b)).toBe(cut(a));
    expect(b).not.toBe(a);
  });
});

describe('runFrontTurn: parallel tool calls', () => {
  it('asks the provider for parallel tool calls and runs a step\'s calls together', async () => {
    h.model = mockModel([toolStep(['reply', { text: 'on it' }], ['react', { emoji: 'eyes' }]), textStep('')]);
    await runFrontTurn(turn({ id: 60 }), io().io);
    const call = ((h.model as any).doStreamCalls as any[])[0];
    expect(call.providerOptions.openrouter.parallel_tool_calls).toBe(true);
    expect(h.slack.filter((c) => c.method === 'reactions.add')).toHaveLength(1);
  });
});

describe('runFrontTurn: a reply or reaction ends the turn', () => {
  const calls = () => ((h.model as any).doStreamCalls as any[]).length;

  it('ends after the reply step, or the reaction step, with no end_turn step', async () => {
    h.model = mockModel([toolStep(['reply', { text: 'yo' }]), textStep('never reached')]);
    const a = io();
    await runFrontTurn(turn({ id: 90 }), a.io);
    expect(calls()).toBe(1);
    expect(a.phases).toEqual(['final']);

    h.model = mockModel([toolStep(['react', { emoji: 'eyes' }]), textStep('never reached')]);
    await runFrontTurn(turn({ id: 91 }), io().io);
    expect(calls()).toBe(1);
  });

  it('ack + spawn in one step ends the turn; the card still goes out', async () => {
    h.model = mockModel([toolStep(['reply', { text: 'on it' }], ['spawn_subagent', { tasks: [{ title: 'Look', instructions: 'look it up' }] }]), textStep('never reached')]);
    await runFrontTurn(turn({ id: 92 }), io().io);
    expect(calls()).toBe(1);
    expect(h.spawns).toHaveLength(1);
    expect(h.postedCards).toEqual([5]);
  });

  it('continues when the step also searched, when continue_turn is set, or when the reply was empty', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    try {
      h.model = mockModel([toolStep(['reply', { text: 'checking' }], ['web_search', { query: 'pico' }]), textStep('')]);
      await runFrontTurn(turn({ id: 93 }), io().io);
      expect(calls()).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }

    h.model = mockModel([toolStep(['reply', { text: 'one sec', continue_turn: true }]), textStep('')]);
    const a = io();
    await runFrontTurn(turn({ id: 94 }), a.io);
    expect(calls()).toBe(2);

    h.model = mockModel([toolStep(['reply', { text: '  ' }]), textStep('')]);
    await runFrontTurn(turn({ id: 95, isMention: false }), io(false).io);
    expect(calls()).toBe(2);
  });

  it("the reply result no longer asks for end_turn", async () => {
    h.model = mockModel([toolStep(['reply', { text: 'one sec', continue_turn: true }]), textStep('')]);
    await runFrontTurn(turn({ id: 96 }), io().io);
    const second = JSON.stringify(((h.model as any).doStreamCalls as any[])[1].prompt);
    expect(second).toContain('Replied (');
    expect(second).not.toContain('call end_turn when');
  });
});

describe('runFrontTurn: conversation state', () => {
  it('frames an addressed (non-mention) turn as talking with the bot', async () => {
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 97, isMention: false, addressed: true }), io(false).io);
    expect(turnText()).toContain('<@U1> is talking with you in this thread (no @mention needed): respond');
    expect(turnText()).not.toContain('unmentioned follow-up');
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 98, isMention: false }), io(false).io);
    expect(turnText()).toContain('This is an unmentioned follow-up');
  });

  it('frames a turn that passed the relevance gate as meant for the bot, not as an optional follow-up', async () => {
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 103, isMention: false, gated: true }), io(false).io);
    expect(turnText()).toContain('a relevance check judged that <new_messages> from <@U1> is meant for you');
    expect(turnText()).toContain('unless it is clearly not for you');
    expect(turnText()).not.toContain('respond only if it is addressed to you');
    // Addressed wins (an answer to the bot / a partner follow-up that also passed the gate).
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 104, isMention: false, gated: true, addressed: true }), io(false).io);
    expect(turnText()).toContain('is talking with you in this thread');
  });

  it('every delivered reply updates the thread (idle clock, partner, awaited answer)', async () => {
    const queries: string[] = [];
    h.sqlHook = (q) => void queries.push(q) as any;
    h.model = mockModel([toolStep(['reply', { text: 'want me to dig deeper?' }])]);
    await runFrontTurn(turn({ id: 99 }), io().io);
    expect(queries.some((q) => q.includes('last_bot_reply_at = now()') && q.includes('awaits_reply_from'))).toBe(true);
  });

  it('records the turn\'s tool calls and shows a recent previous turn\'s calls to the next user turn', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    try {
      h.model = mockModel([toolStep(['web_search', { query: 'nd studio' }]), toolStep(['reply', { text: 'found it' }])]);
      await runFrontTurn(turn({ id: 100 }), io().io);
    } finally {
      vi.unstubAllGlobals();
    }
    const ev = h.events.find((e) => e.type === 'turn_tools')!;
    expect(ev.payload).toEqual({ turnId: 100, calls: [{ tool: 'web_search', args: '{"query":"nd studio"}' }] });

    h.sqlHook = (q) => {
      if (q.includes('from turns where thread_id') && q.includes("status in ('done', 'error')")) return [{ id: 100, finishedAt: new Date() }];
      if (q.includes("type = 'turn_tools'")) return [{ payload: ev.payload }];
      return undefined;
    };
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 101 }), io().io);
    expect(turnText()).toContain('<previous_turn_tools');
    expect(turnText()).toContain('- web_search {"query":"nd studio"}');

    // Too old, or not a user turn: nothing.
    h.sqlHook = (q) => (q.includes('from turns where thread_id') && q.includes("status in ('done', 'error')") ? [{ id: 100, finishedAt: new Date(Date.now() - 3600_000) }] : undefined);
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 102 }), io().io);
    expect(turnText()).not.toContain('<previous_turn_tools');
  });
});

describe('runFrontTurn: bare ping', () => {
  const pingRows = (q: string) => (q.includes('from messages where channel_id') && q.includes('and ts in') ? [{ text: '<@UBOT>', files: [] }] : undefined);

  it("acts on the speaker's own unanswered earlier request instead of asking what they need", async () => {
    h.sqlHook = (q) => {
      if (q.includes('order by ts::numeric desc limit 1') && q.includes('bot_id is null')) return [{ ts: '100.000001', text: 'can you check the pico w price', files: [] }];
      if (q.includes('as answered')) return [{ answered: false }];
      return pingRows(q);
    };
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 110 }), io().io);
    expect(turnText()).toContain('Their earlier message [100.000001] in <thread_history> got no answer from you');
    expect(turnText()).not.toContain('casually asking');
  });

  it('a pointer ping ("^") also acts on the unanswered earlier request; a pointer message is not itself a request', async () => {
    h.sqlHook = (q) => {
      if (q.includes('order by ts::numeric desc limit 1') && q.includes('bot_id is null')) return [{ ts: '100.000001', text: 'make me a landing page for the club', files: [] }];
      if (q.includes('as answered')) return [{ answered: false }];
      if (q.includes('from messages where channel_id') && q.includes('and ts in')) return [{ text: '<@UBOT> ^', files: [] }];
      return undefined;
    };
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 112 }), io().io);
    expect(turnText()).toContain('Their earlier message [100.000001] in <thread_history> got no answer from you');

    h.sqlHook = (q) => {
      if (q.includes('order by ts::numeric desc limit 1') && q.includes('bot_id is null')) return [{ ts: '100.000001', text: '<@UBOT> ^^', files: [] }];
      if (q.includes('as answered')) return [{ answered: false }];
      if (q.includes('from messages where channel_id') && q.includes('and ts in')) return [{ text: '<@UBOT> this', files: [] }];
      return undefined;
    };
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 113 }), io().io);
    expect(turnText()).not.toContain('got no answer from you');
    expect(turnText()).toContain('which message they mean');
  });

  it('asks what they need when the earlier request was answered (or there is none)', async () => {
    h.sqlHook = (q) => {
      if (q.includes('order by ts::numeric desc limit 1') && q.includes('bot_id is null')) return [{ ts: '100.000001', text: 'can you check the pico w price', files: [] }];
      if (q.includes('as answered')) return [{ answered: true }];
      return pingRows(q);
    };
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 111 }), io().io);
    expect(turnText()).toContain('otherwise reply briefly and casually asking what they need');
    expect(turnText()).not.toContain('got no answer from you');
  });
});

describe('barePingKind', () => {
  it('only mentions (and punctuation / politeness): a plain bare ping', () => {
    for (const t of ['<@UBOT>', '<@UBOT|bot> ?', '<@UBOT> pls', '<@UBOT> please!', '<@UBOT> <@U2>', '']) expect(barePingKind(t), t).toBe('plain');
  });

  it('mentions plus a pointer at an earlier message: a pointer ping', () => {
    for (const t of [
      '<@UBOT> ^',
      '<@UBOT> ^^',
      '^^^ <@UBOT>',
      '<@UBOT> ↑',
      '<@UBOT> ⬆️',
      '<@UBOT> ⬆',
      '<@UBOT> :point_up:',
      '<@UBOT> :point_up_2:',
      '<@UBOT> :point_up::skin-tone-3:',
      '<@UBOT> :arrow_up:',
      '<@UBOT> this',
      '<@UBOT> THIS?',
      '<@UBOT> that pls',
      '<@UBOT> above',
      '<@UBOT> see above',
      '<@UBOT> this ^',
      '<@UBOT> this^',
      '<@UBOT> please ^?',
      '<@UBOT>^',
    ])
      expect(barePingKind(t), t).toBe('pointer');
  });

  it('anything else is a request of its own', () => {
    for (const t of [
      '<@UBOT> hi',
      '<@UBOT> do this',
      '<@UBOT> is this true',
      '<@UBOT> see',
      '<@UBOT> above the fold?',
      '<@UBOT> ^ but in python',
      '<@UBOT> :eyes:',
      '<@UBOT> :point_up: also check the docs',
      '<@UBOT> yes',
    ])
      expect(barePingKind(t), t).toBeNull();
  });
});

describe('barePingInstruction', () => {
  it('points at the unanswered request for both kinds; a pointer without one may mean the channel message the thread starts under', () => {
    expect(barePingInstruction({ ts: '1.5' }, 'pointer')).toContain('Their earlier message [1.5] in <thread_history> got no answer from you');
    expect(barePingInstruction({ ts: '1.5' }, 'pointer')).toContain('pointing at an earlier message');
    expect(barePingInstruction({ ts: '1.5' })).toContain('with no new request in the message');
    expect(barePingInstruction(null, 'pointer')).toContain('which message they mean');
    expect(barePingInstruction(null, 'pointer')).not.toContain('Do not answer messages from <channel_background>');
    expect(barePingInstruction(null)).toContain('Do not answer messages from <channel_background>');
  });
});

describe('runFrontTurn: queued user turns in non-user turns', () => {
  it('a synthesis turn is told to leave messages queued as their own turns alone', async () => {
    h.sqlHook = (q) => {
      if (q.includes('from runs r join subagents')) return [{ id: 1, subagentId: 'sa_1', title: 'T', ownerId: 'U1', status: 'complete', instructions: 'x', result: 'r', error: null, isResume: false }];
      if (q.includes("kind = 'user' and status = 'pending'")) return [{ authorId: 'UADMIN', messageTs: ['100.000009', '100.000008'] }];
      return undefined;
    };
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 120, kind: 'synthesis', cardId: 5, messageTs: [], isMention: false }), io(false).io);
    expect(turnText()).toContain('Queued after this turn');
    expect(turnText()).toContain('<@UADMIN>: [100.000008] [100.000009]');
    // Groundwork for a deliverable: produce it now, not a report plus an offer.
    expect(turnText()).toContain('groundwork for something the speaker asked you to produce');

    // User turns don't get it.
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 121 }), io().io);
    expect(turnText()).not.toContain('Queued after this turn');
  });
});

describe('runFrontTurn: spawn_subagent fan-out', () => {
  it('one call with several tasks starts one subagent per task on the same card; a failed one is reported, not fatal', async () => {
    const tasks = [
      { title: 'Pico 2 W', instructions: 'Research the Pico 2 W' },
      { title: 'FAIL', instructions: 'x' },
      { title: 'ESP32-C6', instructions: 'Research the ESP32-C6' },
    ];
    h.model = mockModel([toolStep(['reply', { text: 'on it', continue_turn: true }]), toolStep(['spawn_subagent', { tasks }]), toolStep(['end_turn', {}])]);
    await runFrontTurn(turn({ id: 80 }), io().io);
    expect(h.spawns.map((o) => o.title)).toEqual(['Pico 2 W', 'FAIL', 'ESP32-C6']);
    expect(h.spawns.every((o) => o.turnId === 80 && o.ownerId === 'U1')).toBe(true);
    expect(h.postedCards).toEqual([5]);
    const toolResult = JSON.stringify(((h.model as any).doStreamCalls as any[])[2].prompt);
    expect(toolResult).toContain('sa_1');
    expect(toolResult).toContain('sa_3');
    expect(toolResult).toContain('not_started');
  });
});

describe('runFrontTurn: native stop', () => {
  const slackError = (code: string) => Object.assign(new Error(code), { data: { ok: false, error: code } });

  it('ends at the next step boundary after stop, with no fallback', async () => {
    h.activeRuns = 1; // post mode
    const steps = () => [toolStep(['reply', { text: 'first' }], ['search_emojis', { query: 'y' }]), toolStep(['search_emojis', { query: 'x' }]), textStep('')];
    h.model = mockModel(steps());
    const { io: tio } = io();
    let stop = false;
    // Baseline: without a stop, all three steps run.
    await runFrontTurn(turn({ id: 21 }), { ...tio, stopRequested: async () => stop });
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(3);

    h.slack = [];
    h.events = [];
    h.model = mockModel(steps());
    stop = false;
    h.slackHook = (method) => {
      if (method === 'chat.postMessage') stop = true; // user presses stop right after the first reply lands
    };
    await runFrontTurn(turn({ id: 22 }), { ...io().io, stopRequested: async () => stop });
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(1);
    expect(h.slack.filter((c) => c.method === 'chat.postMessage').map((c) => c.args.text)).toEqual(['first']);
    expect(h.events.some((e) => e.type === 'turn_stopped')).toBe(true);
  });

  it('does not call the model when stop was already requested, and posts no fallback', async () => {
    h.model = mockModel([replyStep('hello')]);
    await runFrontTurn(turn({ id: 23 }), { ...io().io, stopRequested: async () => true });
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(0);
    expect(h.slack.filter((c) => c.method.startsWith('chat.'))).toHaveLength(0);
  });

  it('a stream Slack halted is not re-posted, and the reply tool reports the stop', async () => {
    const text = 'This is a long streamed answer that the user will stop halfway through, sorry.';
    h.model = mockModel([replyStep(text, 4), textStep('')], 30);
    let stop = false;
    h.slackHook = (method) => {
      if (method === 'chat.appendStream') {
        stop = true;
        throw slackError('message_not_in_streaming_state');
      }
      if (method === 'chat.stopStream' && stop) throw slackError('message_not_in_streaming_state');
    };
    await expect(runFrontTurn(turn({ id: 24 }), { ...io().io, stopRequested: async () => stop })).resolves.toBeUndefined();
    const chat = h.slack.map((c) => c.method).filter((m) => m.startsWith('chat.'));
    expect(chat[0]).toBe('chat.startStream');
    expect(chat).not.toContain('chat.postMessage');
    expect(h.events.find((e) => e.type === 'reply')?.payload).toMatchObject({ stopped: true });
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(1);
  });

  it('stops appending to the stream as soon as stop is requested', async () => {
    const text = 'A long streamed answer that keeps going and going while the user loses interest and presses stop.';
    h.model = mockModel([replyStep(text, 3), textStep('')], 25);
    let stop = false;
    let appends = 0;
    h.slackHook = (method) => {
      if (method === 'chat.appendStream' && ++appends === 2) stop = true;
    };
    await runFrontTurn(turn({ id: 26 }), { ...io().io, stopRequested: async () => stop });
    const chat = h.slack.map((c) => c.method).filter((m) => m.startsWith('chat.'));
    expect(chat.filter((m) => m === 'chat.appendStream')).toHaveLength(2);
    expect(chat.at(-1)).toBe('chat.stopStream');
    expect(chat).not.toContain('chat.postMessage');
  });

  it('a halted stream is not re-posted even before the stop flag is visible', async () => {
    const text = 'Another long streamed answer, halted by Slack before our worker saw the stop event.';
    h.model = mockModel([replyStep(text, 4), textStep('')], 30);
    h.slackHook = (method) => {
      if (method === 'chat.appendStream' || method === 'chat.stopStream') throw slackError('message_not_in_streaming_state');
    };
    await runFrontTurn(turn({ id: 25 }), { ...io().io, stopRequested: async () => false });
    expect(h.slack.map((c) => c.method)).not.toContain('chat.postMessage');
  });
});

describe('runFrontTurn: model freedom', () => {
  const toolNames = (i: number) => (((h.model as any).doStreamCalls as any[])[i].tools ?? []).map((t: any) => t.name);
  const methods = () => h.slack.map((c) => c.method);

  it('lets the model both react and reply, and ends when it stops calling tools', async () => {
    h.activeRuns = 1;
    h.model = mockModel([toolStep(['react', { emoji: 'tada', continue_turn: true }]), toolStep(['reply', { text: 'congrats on shipping it!', continue_turn: true }]), textStep('')]);
    await runFrontTurn(turn({ id: 70 }), io().io);
    expect(methods()).toContain('reactions.add');
    expect(methods()).toContain('chat.postMessage');
    expect(methods()).not.toContain('reactions.remove');
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(3);
  });

  it('a reaction-only turn with end_turn completes with no chat post', async () => {
    h.model = mockModel([toolStep(['react', { emoji: 'heart' }], ['end_turn', {}])]);
    await expect(runFrontTurn(turn({ id: 72 }), io(true).io)).resolves.toBeUndefined();
    expect(methods()).toEqual(['reactions.add']);
    expect(h.events.some((e) => e.type === 'reply')).toBe(false);
  });

  it('posts a second reply if the model sends one', async () => {
    h.activeRuns = 1;
    h.model = mockModel([toolStep(['reply', { text: 'one sec', continue_turn: true }]), toolStep(['reply', { text: 'one sec' }]), textStep('')]);
    await runFrontTurn(turn({ id: 71 }), io().io);
    expect(h.slack.filter((c) => c.method === 'chat.postMessage').length).toBe(2);
  });

  it('only offers set_card_title on synthesis turns', async () => {
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 45, isMention: false }), io(false).io);
    expect(toolNames(0)).toContain('reply');
    expect(toolNames(0)).not.toContain('set_card_title');

    h.sqlHook = (q) => (q.includes('from runs r join subagents') ? [{ id: 1, subagentId: 'sa_1', title: 'T', ownerId: 'U1', status: 'complete', instructions: 'x', result: 'r', error: null, isResume: false }] : undefined);
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 46, kind: 'synthesis', cardId: 5, messageTs: [] }), io(false).io);
    expect(toolNames(0)).toContain('set_card_title');
  });

  it('only offers set_session_title in DM threads, with the current title in <session>', async () => {
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 47, isMention: false }), io(false).io);
    expect(toolNames(0)).not.toContain('set_session_title');
    expect(JSON.stringify(h.model.doStreamCalls[0].prompt.at(-1))).not.toContain('<session>');

    h.sqlHook = (q) => (q.includes('left join agent_sessions') ? [{ isDm: true, title: 'Pico question', titleBy: 'user' }] : undefined);
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 48 }), io().io);
    expect(toolNames(0)).toContain('set_session_title');
    const prompt = JSON.stringify(h.model.doStreamCalls[0].prompt.at(-1));
    expect(prompt).toContain('<session>');
    expect(prompt).toContain('Title: \\"Pico question\\" (chosen by the user');
  });

});

describe('runFrontTurn: status activity', () => {
  function ioWithActivity(isMention: boolean) {
    const activity: string[] = [];
    return { activity, io: { ...io(isMention).io, setActivity: (t: string) => void activity.push(t) } };
  }

  it('reports work tools once each (from input start), never reply/react/search_emojis', async () => {
    const input = JSON.stringify({ tasks: [{ title: 'Research', instructions: 'Research it' }] });
    const spawnStreamed = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 's1', toolName: 'spawn_subagent' },
      { type: 'tool-input-delta', id: 's1', delta: input },
      { type: 'tool-input-end', id: 's1' },
      { type: 'tool-call', toolCallId: 's1', toolName: 'spawn_subagent', input },
      { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
    ];
    h.model = mockModel([toolStep(['search_emojis', { query: 'x' }]), spawnStreamed, replyStep('On it.'), textStep('')]);
    const { io: tio, activity } = ioWithActivity(false);
    await runFrontTurn(turn({ id: 60, isMention: false }), tio);
    expect(activity).toEqual(['Starting a subagent…']);
  });

  it('web_search is a client tool: announced as "Searching the web…", Exa results go back to the model', async () => {
    const exa: any[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      exa.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ results: [{ title: 'Pico 2 W', url: 'https://example.com/pico', highlights: ['Costs $7.'] }], costDollars: { total: 0.004 } });
    });
    try {
      h.model = mockModel([toolStep(['web_search', { query: 'pico 2 w price' }]), replyStep('About $7.'), textStep('')]);
      const { io: tio, activity } = ioWithActivity(true);
      await runFrontTurn(turn({ id: 64 }), tio);
      expect(activity).toEqual(['Searching the web…']);
      expect(exa).toEqual([{ url: 'https://api.exa.ai/search', body: expect.objectContaining({ query: 'pico 2 w price', type: 'instant' }) }]);
      const second = JSON.stringify(h.model.doStreamCalls[1].prompt);
      expect(second).toContain('https://example.com/pico');
      expect(second).toContain('Costs $7.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a turn that only replies or reacts reports no activity', async () => {
    h.model = mockModel([replyStep('Sure thing.'), textStep('')]);
    const a = ioWithActivity(false);
    await runFrontTurn(turn({ id: 61, isMention: false }), a.io);
    h.model = mockModel([toolStep(['react', { emoji: 'thumbsup' }]), textStep('')]);
    const b = ioWithActivity(false);
    await runFrontTurn(turn({ id: 62, isMention: false }), b.io);
    h.model = mockModel([textStep('nothing to add')]);
    const c = ioWithActivity(false);
    await runFrontTurn(turn({ id: 63, isMention: false }), c.io);
    expect([a.activity, b.activity, c.activity]).toEqual([[], [], []]);
  });

  describe('activity cards (STATUS_ACTIVITY_MODE=tasks)', () => {
    const exaOk = async () => Response.json({ results: [{ title: 'Pico', url: 'https://example.com/pico', highlights: ['Costs $7.'] }] });
    const cards = (m: { args: any }) => (m.args.chunks ?? []).filter((c: any) => c.type === 'task_update').map((c: any) => `${c.title}:${c.status}`);

    it('the lookup shows as a task card in the message the reply then streams into; the final message drops it', async () => {
      vi.stubGlobal('fetch', exaOk);
      const released: number[] = [];
      try {
        h.model = mockModel([toolStep(['web_search', { query: 'pico price' }]), replyStep('About $7 at most shops.'), textStep('')]);
        const a = ioWithActivity(true);
        await runFrontTurn(turn({ id: 65 }), { ...a.io, sessionReleased: () => void released.push(1) });
        const chat = h.slack.filter((c) => c.method.startsWith('chat.'));
        expect([...new Set(chat.map((c) => c.method))]).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.update']);
        expect(chat.filter((c) => c.method === 'chat.startStream')).toHaveLength(1); // one message for card + reply
        expect(cards(chat[0]!)).toEqual(['Searching the web…:in_progress']);
        expect(cards(chat[1]!)).toEqual(['Searching the web…:complete']);
        expect(chat[1]!.args.chunks.at(-1)).toMatchObject({ type: 'markdown_text' });
        expect(chat.at(-1)!.args.blocks).toEqual([{ type: 'markdown', text: 'About $7 at most shops.' }]);
        expect(released).toEqual([1]); // the reply's stopStream set the session active
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('a turn that looks something up and then stays silent leaves nothing behind', async () => {
      vi.stubGlobal('fetch', exaOk);
      try {
        h.model = mockModel([toolStep(['web_search', { query: 'pico price' }]), textStep('')]);
        await runFrontTurn(turn({ id: 66 }), ioWithActivity(true).io);
        // the activity message is gone before the mention fallback is posted
        expect(h.slack.filter((c) => c.method.startsWith('chat.')).map((c) => c.method)).toEqual(['chat.startStream', 'chat.stopStream', 'chat.delete', 'chat.postMessage']);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('unmentioned follow-ups get no cards (no post + delete in the thread), only the lifecycle status', async () => {
      vi.stubGlobal('fetch', exaOk);
      try {
        h.model = mockModel([toolStep(['web_search', { query: 'pico price' }]), textStep('')]);
        const a = ioWithActivity(false);
        await runFrontTurn(turn({ id: 68, isMention: false }), a.io);
        expect(a.activity).toEqual(['Searching the web…']);
        expect(h.slack.filter((c) => c.method.startsWith('chat.'))).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('no new activity message once the turn has replied (the status still shows the work)', async () => {
      vi.stubGlobal('fetch', exaOk);
      try {
        h.model = mockModel([replyStep('Let me check.', 7, { continue_turn: true }), toolStep(['web_search', { query: 'pico price' }]), textStep('')]);
        const a = ioWithActivity(true);
        await runFrontTurn(turn({ id: 69 }), a.io);
        expect(a.activity).toEqual(['Searching the web…']);
        const chat = h.slack.filter((c) => c.method.startsWith('chat.'));
        expect(chat.filter((c) => c.method === 'chat.startStream')).toHaveLength(1); // the reply only
        expect(chat.flatMap(cards)).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('no activity cards when the pipeline shows no status (no setActivity)', async () => {
      vi.stubGlobal('fetch', exaOk);
      try {
        h.model = mockModel([toolStep(['web_search', { query: 'pico price' }]), textStep('')]);
        await runFrontTurn(turn({ id: 67, isMention: false }), io(false).io);
        expect(h.slack.filter((c) => c.method.startsWith('chat.'))).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe('scheduled turns (reminders / watch notifications)', () => {
  it('renders the stored input in place of new messages', async () => {
    h.sqlHook = (q) => (q.includes('scheduled_turn_inputs') ? [{ source: 'reminder', input: '<reminder id="r_9" owner="<@U1>">check the release</reminder>' }] : undefined);
    h.model = mockModel([replyStep('<@U1> time to check the release'), textStep('')]);
    await runFrontTurn(turn({ id: 70, kind: 'scheduled', messageTs: [] }), io(true).io);
    const prompt = JSON.stringify(h.model.doStreamCalls[0].prompt.filter((m: any) => m.role === 'user'));
    expect(prompt).toContain('check the release');
    expect(prompt).not.toContain('<new_messages');
    expect(h.slack.some((c) => c.method === 'chat.startStream' || c.method === 'chat.postMessage')).toBe(true);
  });
});

// Review #2: a confirmation outcome must not depend on the model. Silent, failing or stopped outcome turns post the
// code-written fallback (never the generic "couldn't come up with a reply" / error texts).
describe('confirmation outcome turns (send_message / coding-agent launch)', () => {
  const outcomeRow = (fallback: string | null, source = 'send') => (q: string) =>
    q.includes('scheduled_turn_inputs') ? [{ source, input: '<send_outcome id="p1" status="sent"/>', fallback }] : undefined;
  const posts = () => h.slack.filter((c) => c.method === 'chat.postMessage').map((c) => c.args.text);
  const failing = () =>
    new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error('model down'), { isRetryable: false });
      },
    });

  it('a silent outcome turn posts the fallback instead of the generic text', async () => {
    h.sqlHook = outcomeRow('sent ✓ https://x.slack.com/archives/C9/p1');
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 80, kind: 'scheduled', messageTs: [] }), io(true).io);
    expect(posts()).toEqual(['sent ✓ https://x.slack.com/archives/C9/p1']);
    expect(h.events.find((e) => e.type === 'reply')?.payload).toMatchObject({ fallback: true, outcome: true });
  });

  it('a failing outcome turn posts the fallback and does not throw (no "Something broke")', async () => {
    h.sqlHook = outcomeRow('sent ✓ https://x.slack.com/archives/C9/p1');
    h.model = failing();
    await expect(runFrontTurn(turn({ id: 81, kind: 'scheduled', messageTs: [] }), io(true).io)).resolves.toBeUndefined();
    expect(posts()).toEqual(['sent ✓ https://x.slack.com/archives/C9/p1']);
  });

  it('a stopped outcome turn still posts the factual fallback', async () => {
    h.sqlHook = outcomeRow('sent ✓ https://x.slack.com/archives/C9/p1');
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 84, kind: 'scheduled', messageTs: [] }), { ...io(true).io, stopRequested: async () => true });
    expect(posts()).toEqual(['sent ✓ https://x.slack.com/archives/C9/p1']);
  });

  it('no fallback (cancel): silent or failing posts nothing at all', async () => {
    h.sqlHook = outcomeRow(null);
    h.model = mockModel([textStep('')]);
    await runFrontTurn(turn({ id: 82, kind: 'scheduled', messageTs: [] }), io(true).io);
    h.model = failing();
    await expect(runFrontTurn(turn({ id: 83, kind: 'scheduled', messageTs: [] }), io(true).io)).resolves.toBeUndefined();
    expect(posts()).toEqual([]);
  });

  it("the agent's own reply means no fallback", async () => {
    h.sqlHook = outcomeRow('sent ✓ https://x.slack.com/archives/C9/p1');
    h.model = mockModel([replyStep('sent, here it is: https://x.slack.com/archives/C9/p1'), textStep('')]);
    await runFrontTurn(turn({ id: 85, kind: 'scheduled', messageTs: [] }), io(true).io);
    expect(h.slack.filter((c) => c.method === 'chat.postMessage' && c.args.text?.startsWith('sent ✓'))).toHaveLength(0);
  });
});
