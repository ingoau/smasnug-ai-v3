/** The reply tool's `stream` flag and the opening-layout hold (slack-markdown streamHold). */
import '../tools/test-env.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; args: any; opts?: any; at: number }[] = [];
let failOn: ((method: string, args: any) => string | null) | null = null;
let latency: Record<string, number> = {};
let n = 0;
vi.mock('../core/slack.js', () => ({
  slackCall: vi.fn(async (method: string, args: any, opts?: any) => {
    calls.push({ method, args, opts, at: Date.now() });
    if (latency[method]) await new Promise((r) => setTimeout(r, latency[method]));
    const code = failOn?.(method, args);
    if (code) throw Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
    if (method === 'chat.startStream' || method === 'chat.postMessage') return { ok: true, ts: `1700000000.00000${++n}` };
    return { ok: true, ts: args.ts, team_id: 'T1' };
  }),
  slackErrorCode: (err: any) => err?.data?.error,
}));
vi.mock('../core/events.js', async (orig) => ({ ...(await orig<typeof import('../core/events.js')>()), appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}), uploadPrivateFiles: vi.fn(async () => []) }));
vi.mock('./charts-store.js', () => ({ saveReplyExtras: vi.fn(async () => {}) }));

const { ReplyManager, editRetry, earlyStream, EMPTY_RESULT } = await import('./reply.js');
editRetry.delaysMs = [5, 5];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const methods = () => calls.map((c) => c.method);
const streamCalls = () => calls.filter((c) => c.method.startsWith('chat.') && c.method.endsWith('Stream'));

const target = (extra: Record<string, unknown> = {}) => ({
  threadId: 'D1:1.1',
  channelId: 'D1',
  threadTs: '1.1',
  turnId: 5,
  turnKind: 'user' as const,
  recipientUserId: 'U1',
  activeRuns: async () => 0,
  ...extra,
});

async function argsIn(rm: InstanceType<typeof ReplyManager>, args: Record<string, unknown>) {
  const json = JSON.stringify(args);
  for (let i = 0; i < json.length; i += 9) {
    rm.delta('tc1', json.slice(i, i + 9));
    await sleep(5);
  }
  await sleep(300);
}

beforeEach(() => {
  calls.length = 0;
  failOn = null;
  latency = {};
  earlyStream.enabled = true;
  n = 0;
});

const appended = () => calls.filter((c) => c.method === 'chat.appendStream');
const posted = () => calls.filter((c) => c.method === 'chat.postMessage');

describe('reply stream flag and opening-layout hold', () => {
  it('stream: false (sent first) posts the reply once: nothing appended, the empty early stream removed', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'A long enough reply that would normally stream in.';
    await argsIn(rm, { stream: false, text });
    expect(await rm.finish('tc1', text, undefined, undefined, undefined, { stream: false })).toBe('Replied (posted).');
    expect(appended()).toHaveLength(0);
    expect(posted()).toHaveLength(1);
    const early = calls.find((c) => c.method === 'chat.startStream')!.args;
    expect(early.markdown_text).toBeUndefined();
    expect(methods()).toContain('chat.delete'); // the empty early stream went
    expect(methods().indexOf('chat.delete')).toBeLessThan(methods().indexOf('chat.postMessage'));
  });

  it('a heading followed by a marker is held, then posted whole (no heading-only flash)', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = '# Results\n[[divider]]\nAll done, here is the summary of everything.';
    await argsIn(rm, { text });
    expect(await rm.finish('tc1', text)).toBe('Replied (posted).');
    expect(appended()).toHaveLength(0);
    expect(posted()).toHaveLength(1);
  });

  it('a reply opening with a marker is posted whole', async () => {
    const rm = new ReplyManager(target());
    const text = '[[divider]]\nThen the words, quite a few of them.';
    await argsIn(rm, { text });
    expect(await rm.finish('tc1', text)).toBe('Replied (posted).');
    expect(streamCalls()).toHaveLength(0);
  });

  it('a heading followed by text streams as before', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = '# Results\nAll done, here is the summary of everything.';
    await argsIn(rm, { text });
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    expect(appended().length).toBeGreaterThan(0);
    expect(posted()).toHaveLength(0);
  });

  it('plain text streams as before; a late stream: false (after text went out) changes nothing', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'Plain words that stream in as they always did.';
    await argsIn(rm, { text, stream: false });
    expect(await rm.finish('tc1', text, undefined, undefined, undefined, { stream: false })).toBe('Replied (streamed).');
    expect(appended().length).toBeGreaterThan(0);
    expect(posted()).toHaveLength(0);
  });

  it('stream: false with no deltas seen (execute only) still posts whole', async () => {
    const rm = new ReplyManager(target());
    expect(await rm.finish('tc1', 'Just this.', undefined, undefined, undefined, { stream: false })).toBe('Replied (posted).');
    expect(streamCalls()).toHaveLength(0);
  });
});
