import '../tools/test-env.js';
import { describe, expect, it, vi } from 'vitest';

const calls: { method: string; args: any }[] = [];
let failOn: ((method: string, args: any) => string | null) | null = null;
vi.mock('../core/slack.js', () => ({
  slackCall: vi.fn(async (method: string, args: any) => {
    calls.push({ method, args });
    const code = failOn?.(method, args);
    if (code) throw Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
    return { ok: true, ts: '1700000000.000900', team_id: 'T1' };
  }),
  slackErrorCode: (err: any) => err?.data?.error,
}));
vi.mock('../core/events.js', () => ({ appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}) }));
vi.mock('./charts-store.js', () => ({ saveReplyCharts: vi.fn(async () => {}) }));
vi.mock('./reply-buttons-store.js', () => ({
  createReplyButtons: vi.fn(async (o: any) => ({ id: 42, threadId: o.threadId, channelId: o.channelId, turnId: o.turnId, messageTs: null, replyText: null, labels: o.labels, pressedBy: null, pressedLabel: null, pressedMessageTs: null, pressedAt: null })),
  setButtonsMessage: vi.fn(async () => {}),
  toButtonsState: (r: any) => ({ id: r.id, labels: r.labels, pressedBy: r.pressedBy, pressedLabel: r.pressedLabel }),
}));

const { ReplyManager } = await import('./reply.js');
const { streamArgsText } = await import('./slack-markdown.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const target = (turnKind: 'user' | 'synthesis' = 'user', runs = 0) => ({
  threadId: 'C1:1.1',
  channelId: 'C1',
  threadTs: '1.1',
  turnId: 1,
  turnKind,
  recipientUserId: 'U1',
  activeRuns: async () => runs,
});

describe('reply: group pings are neutralised (workspace guidelines)', () => {
  it('posted replies never carry a broadcast or user-group mention', async () => {
    calls.length = 0;
    const rm = new ReplyManager(target('synthesis'));
    await rm.finish('tc1', 'Heads up <!channel> and <!subteam^S1|@design>, also @here and <!everyone>. cc <@U2>');
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    const sent = JSON.stringify(post.args);
    expect(sent).not.toMatch(/<!(channel|here|everyone|subteam)/);
    expect(post.args.text).toContain('@​channel');
    expect(post.args.text).toContain('@​design');
    expect(post.args.text).toContain('@​here');
    expect(post.args.text).toContain('<@U2>'); // user mentions are fine
  });
});

const HTML_REPLY = 'Here is a starter page:\n\n```html\n<h1>Hello, world!</h1>\n<img src="cat.png">\n```\n\nUse the `<h1>` tag once per page.';
const htmlPre = { type: 'rich_text_preformatted', language: 'html', elements: [{ type: 'text', text: '<h1>Hello, world!</h1>\n<img src="cat.png">' }] };

/** Feed the reply tool's JSON arguments in small deltas, like the model stream does. */
async function streamIn(rm: InstanceType<typeof ReplyManager>, text: string, size = 9) {
  const json = JSON.stringify({ text });
  for (let i = 0; i < json.length; i += size) {
    rm.delta('tc1', json.slice(i, i + size));
    await sleep(5);
  }
  await sleep(300);
}

describe('reply: code is delivered exactly as written', () => {
  it('posted: prose as markdown blocks, code as rich_text preformatted with its language, raw text fallback', async () => {
    calls.length = 0;
    failOn = null;
    await new ReplyManager(target('user', 1)).finish('tc1', HTML_REPLY);
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args.text).toBe(HTML_REPLY);
    expect(post.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'rich_text', 'rich_text']);
    expect(post.args.blocks[0]).toEqual({ type: 'markdown', text: 'Here is a starter page:' });
    expect(post.args.blocks[1].elements).toEqual([htmlPre]);
    expect(post.args.blocks[2].elements[0].elements).toContainEqual({ type: 'text', text: '<h1>', style: { code: true } });
  });

  it('streamed: chunks mode throughout, code held until its fence closes and sent as a blocks chunk, then the final layout', async () => {
    calls.length = 0;
    failOn = null;
    const rm = new ReplyManager(target('user'));
    await streamIn(rm, HTML_REPLY);
    const res = await rm.finish('tc1', HTML_REPLY, undefined, ['Thanks']);
    expect(res).toMatch(/^Replied \(streamed\)/);
    const stream = calls.filter((c) => ['chat.startStream', 'chat.appendStream', 'chat.stopStream'].includes(c.method));
    expect(stream[0]!.method).toBe('chat.startStream');
    for (const c of stream) expect(c.args.markdown_text).toBeUndefined(); // never mixes modes
    const chunks = stream.flatMap((c) => c.args.chunks ?? []);
    // Markdown text never contains the code (Slack would rewrite <h1> inside it).
    const md = stream.map((c) => streamArgsText(c.args)).join('');
    expect(md).toBe('Here is a starter page:\n\nUse the ');
    expect(md).not.toContain('Hello, world');
    const blocks = chunks.filter((c: any) => c.type === 'blocks').flatMap((c: any) => c.blocks);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].elements).toEqual([htmlPre]);
    expect(blocks[1].elements[0].elements[0]).toEqual({ type: 'text', text: '<h1>', style: { code: true } });
    // Order: prose, code, rest.
    const kinds = chunks.map((c: any) => c.type);
    expect(kinds.indexOf('blocks')).toBeGreaterThan(kinds.indexOf('markdown_text'));
    // Buttons on stopStream, then the message is re-rendered with the posted layout (+ buttons).
    const stop = calls.find((c) => c.method === 'chat.stopStream')!;
    expect(stop.args.blocks.map((b: any) => b.type)).toEqual(['actions']);
    const upd = calls.find((c) => c.method === 'chat.update')!;
    expect(upd.args.ts).toBe('1700000000.000900');
    expect(upd.args.text).toBe(HTML_REPLY);
    expect(upd.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'rich_text', 'rich_text', 'actions']);
    expect(upd.args.blocks[1].elements).toEqual([htmlPre]);
  });

  it('streamed prose without code: markdown_text chunks only, no extra update', async () => {
    calls.length = 0;
    failOn = null;
    const text = 'Plain answer with **bold**, a `<b>` tag and <h2>inline html</h2>.';
    const rm = new ReplyManager(target('user'));
    await streamIn(rm, text);
    await rm.finish('tc1', text);
    const md = calls.filter((c) => c.method === 'chat.startStream' || c.method === 'chat.appendStream').map((c) => streamArgsText(c.args)).join('');
    expect(md).toBe('Plain answer with **bold**, a `<b>` tag and &lt;h2>inline html&lt;/h2>.');
    expect(calls.some((c) => c.method === 'chat.update')).toBe(false);
  });

  it('a stream that fails midway is completed with chat.update into one message', async () => {
    calls.length = 0;
    failOn = (m, a) => (m === 'chat.appendStream' && a.chunks?.some((c: any) => c.type === 'blocks') ? 'invalid_chunks' : null);
    const rm = new ReplyManager(target('user'));
    await streamIn(rm, HTML_REPLY);
    await rm.finish('tc1', HTML_REPLY);
    failOn = null;
    expect(calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
    const upd = calls.find((c) => c.method === 'chat.update')!;
    expect(upd.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'rich_text', 'rich_text']);
  });
});

describe('reply charts', () => {
  const charts = [{ title: 'Weekly signups', type: 'bar', series: [{ name: 'Signups', data: [{ label: 'Mon', value: 10 }, { label: 'Tue', value: 4 }] }], x_label: 'Day', y_label: 'Count' }];

  it('posts a data_visualization block between the text and the buttons', async () => {
    calls.length = 0;
    failOn = null;
    const res = await new ReplyManager(target('user', 1)).finish('tc1', 'signups dipped tuesday', undefined, ['More'], charts);
    expect(res).toMatch(/^Replied \(posted\)/);
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'data_visualization', 'actions']);
    expect(post.args.blocks[1]).toMatchObject({
      type: 'data_visualization',
      block_id: 'chart_1',
      title: 'Weekly signups',
      chart: { type: 'bar', axis_config: { categories: ['Mon', 'Tue'], x_label: 'Day', y_label: 'Count' } },
    });
    expect(post.args.text).toContain('signups dipped tuesday');
    expect(post.args.text).toContain('Weekly signups (bar)');
    expect(JSON.stringify(post.args)).not.toMatch(/<!(channel|here|everyone)/);
  });

  it('a streamed reply gets the chart on stopStream and in the final layout', async () => {
    calls.length = 0;
    failOn = null;
    const rm = new ReplyManager(target('user'));
    await streamIn(rm, 'signups dipped tuesday');
    await rm.finish('tc1', 'signups dipped tuesday', undefined, undefined, charts);
    const stop = calls.find((c) => c.method === 'chat.stopStream')!;
    expect(stop.args.blocks.map((b: any) => b.type)).toEqual(['data_visualization']);
    const upd = calls.find((c) => c.method === 'chat.update')!;
    expect(upd.args.blocks.map((b: any) => b.type)).toEqual(['markdown', 'data_visualization']);
    expect(upd.args.blocks[1].chart.series[0].data).toEqual([{ label: 'Mon', value: 10 }, { label: 'Tue', value: 4 }]);
  });

  it('a failed stream whose update fails still posts the chart', async () => {
    calls.length = 0;
    failOn = (m) => (m === 'chat.appendStream' || m === 'chat.update' ? 'invalid_blocks' : null);
    const text = 'signups dipped tuesday and then recovered quite a lot over the week';
    const rm = new ReplyManager(target('user'));
    await streamIn(rm, text);
    await rm.finish('tc1', text, undefined, undefined, charts);
    failOn = null;
    const post = calls.find((c) => c.method === 'chat.postMessage');
    expect(post?.args.blocks.some((b: any) => b.type === 'data_visualization')).toBe(true);
    expect(post?.args.blocks.find((b: any) => b.type === 'data_visualization').chart.axis_config.categories).toEqual(['Mon', 'Tue']);
  });

  it('a chart-only reply posts, and a chart with no title does not block the text', async () => {
    calls.length = 0;
    const res = await new ReplyManager(target('synthesis')).finish('tc1', '   ', undefined, undefined, [{ title: 'Candy', type: 'pie', segments: [{ label: 'A', value: 2 }, { label: 'B', value: 1 }] }]);
    expect(res).toMatch(/^Replied \(posted\)/);
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args.blocks.map((b: any) => b.type)).toEqual(['data_visualization']);
    expect(post.args.text).toContain('Candy (pie)');
    calls.length = 0;
    const kept = await new ReplyManager(target('synthesis')).finish('tc1', 'just the words', undefined, undefined, [{ type: 'pie', segments: [{ label: 'A', value: 1 }] }]);
    expect(kept).toMatch(/no title/);
    expect(calls.find((c) => c.method === 'chat.postMessage')!.args.blocks.map((b: any) => b.type)).toEqual(['markdown']);
  });
});

describe('HALTED_STREAM', () => {
  it('matches every way Slack says a stream is no longer open, including stopped_by_user', async () => {
    const { HALTED_STREAM } = await import('./reply.js');
    for (const code of ['stopped_by_user', 'not_in_streaming_state', 'message_not_in_streaming_state', 'streaming_state_conflict']) expect(HALTED_STREAM.test(code), code).toBe(true);
    expect(HALTED_STREAM.test('ratelimited')).toBe(false);
  });
});
