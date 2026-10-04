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
}));

vi.mock('../db/index.js', () => {
  const sql: any = async (strings: TemplateStringsArray) => h.sqlHook?.(Array.isArray(strings) ? strings.join('?') : '') ?? [];
  sql.json = (v: unknown) => v;
  sql.begin = async (fn: any) => fn(sql);
  return { sql };
});
vi.mock('../core/redis.js', () => ({ redis: {}, bullConnection: () => ({}) }));
vi.mock('../core/slack.js', () => ({
  getBotIdentity: async () => ({ userId: 'UBOT', botId: 'BBOT' }),
  slackErrorCode: (err: any) => err?.data?.error,
  slackCall: async (method: string, args: any) => {
    h.slack.push({ method, args });
    h.slackHook?.(method, args);
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
vi.mock('./subagents.js', () => ({
  activeRunsInThread: async () => h.activeRuns,
  spawnSubagent: async () => ({ subagentId: 'sa_1', runId: 1, cardId: 5 }),
  cancelSubagent: async (o: any) => `Subagent ${o.subagentId} cancelled.`,
  messageSubagent: async () => ({ mode: 'steered', runId: 1, cardId: 5, note: 'n' }),
}));
vi.mock('./cards.js', () => ({ postCard: async (id: number) => void h.postedCards.push(id), freezeCard: async () => {}, scheduleCardRender: async () => {} }));
vi.mock('../context/thread.js', () => ({
  renderThreadContext: async () => ({ history: '<@U1> Tess: earlier', channelContext: '', newMessages: '<@U1> Tess: hi bot' }),
  renderMessages: async (_t: string, ts: string[]) => `<@U1> Tess: INBOX ${ts.join(',')}`,
}));
vi.mock('../models.js', () => ({
  MODELS: { gate: 'm', front: 'm', child: 'm' },
  chatModel: () => h.model,
}));
vi.mock('../features/guard.js', async (orig) => ({ ...(await orig<typeof import('../features/guard.js')>()), takeLimit: async () => null }));
vi.mock('../context/users.js', () => ({ getUserInfo: async (id: string) => ({ id, name: 'Tess', tz: 'Europe/Berlin', isBot: false }) }));

const { MockLanguageModelV4 } = await import('ai/test');
const { simulateReadableStream } = await import('ai');
await import('./tools.js');
await import('../tools/web-search.js');
await import('../tools/emoji.js');
await import('./session-title.js');
const { runFrontTurn } = await import('./front.js');
const { streamArgsText } = await import('./slack-markdown.js');

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

beforeEach(() => {
  h.slack = [];
  h.events = [];
  h.activeRuns = 0;
  h.slackHook = undefined;
  h.sqlHook = undefined;
  h.postedCards = [];
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
    // The model decides when it's done: it gets one more step after replying and ends by not calling tools.
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(2);
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
    h.model = mockModel([toolStep(['react', { emoji: 'tada' }]), toolStep(['reply', { text: 'congrats on shipping it!' }]), textStep('')]);
    await runFrontTurn(turn({ id: 70 }), io().io);
    expect(methods()).toContain('reactions.add');
    expect(methods()).toContain('chat.postMessage');
    expect(methods()).not.toContain('reactions.remove');
    expect(((h.model as any).doStreamCalls as any[]).length).toBe(3);
  });

  it('posts a second reply if the model sends one', async () => {
    h.activeRuns = 1;
    h.model = mockModel([toolStep(['reply', { text: 'one sec' }]), toolStep(['reply', { text: 'one sec' }]), textStep('')]);
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
    const input = JSON.stringify({ title: 'Research', instructions: 'Research it' });
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
        await runFrontTurn(turn({ id: 66, isMention: false }), ioWithActivity(false).io);
        expect(h.slack.filter((c) => c.method.startsWith('chat.')).map((c) => c.method)).toEqual(['chat.startStream', 'chat.stopStream', 'chat.delete']);
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
