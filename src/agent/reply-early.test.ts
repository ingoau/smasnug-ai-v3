/** The reply stream opened early: chat.startStream (empty) when the reply call begins, the first text appended. */
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
const { TurnTiming } = await import('../core/timing.js');
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

async function streamIn(rm: InstanceType<typeof ReplyManager>, text: string) {
  const json = JSON.stringify({ text });
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

describe('reply stream opened early', () => {
  it('opens an empty stream when the call begins, then appends the first text to it (one startStream)', async () => {
    const timing = new TurnTiming();
    const rm = new ReplyManager(target({ timing }));
    rm.open('tc1');
    await sleep(10);
    // Before any text: one startStream with no content (the mode is fixed by the first chunks).
    expect(methods()).toEqual(['auth.test', 'chat.startStream']);
    const start = calls[1]!;
    expect(start.args.chunks).toBeUndefined();
    expect(start.args.markdown_text).toBeUndefined();
    expect(start.args).toMatchObject({ channel: 'D1', thread_ts: '1.1', recipient_user_id: 'U1', recipient_team_id: 'T1' });
    expect(start.opts).toEqual({ idempotencyKey: 'reply:5:0:early' });
    const text = 'Hello there! Here is the answer you asked for.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    const s = streamCalls();
    expect(s.map((c) => c.method)).toEqual(['chat.startStream', ...s.slice(1, -1).map(() => 'chat.appendStream'), 'chat.stopStream']);
    expect(s.slice(1).every((c) => c.args.ts === '1700000000.000001')).toBe(true); // the early stream's ts
    expect(s[1]!.args.chunks[0].type).toBe('markdown_text');
    expect(s.flatMap((c) => c.args.chunks ?? []).map((k: any) => k.text).join('')).toBe(text);
    expect(methods()).not.toContain('chat.delete');
    expect(rm.lastDelivered?.ts).toBe('1700000000.000001');
    // Marks: the empty open first; stream_started = the first text visible (the headline's first text).
    const m = timing.marks;
    expect(m.early_stream_open_call).toBeLessThanOrEqual(m.early_stream_open!);
    expect(m.early_stream_open).toBeLessThanOrEqual(m.first_reply_text!);
    expect(m.first_reply_text).toBeLessThanOrEqual(m.stream_open_call!);
    expect(m.stream_open_call).toBeLessThanOrEqual(m.stream_started!);
  });

  it('startStream overlaps the model writing: the first flush waits for it instead of opening another', async () => {
    latency = { 'chat.startStream': 150 };
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'Quick answer coming right up, with a few words.';
    rm.delta('tc1', JSON.stringify({ text }).slice(0, 30)); // ready to flush while startStream is in flight
    await sleep(400);
    expect(methods().filter((m) => m === 'chat.startStream')).toHaveLength(1);
    const start = calls.find((c) => c.method === 'chat.startStream')!;
    const append = calls.find((c) => c.method === 'chat.appendStream')!;
    expect(append.at).toBeGreaterThanOrEqual(start.at + 150);
    expect(append.args.chunks[0].text).toMatch(/^Quick answer/);
    rm.delta('tc1', JSON.stringify({ text }).slice(30));
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
  });

  it('a reply finished before any flush streams into the open early stream', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    await sleep(10);
    const text = 'All at once.';
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    expect(streamCalls().map((c) => c.method)).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream']);
    expect(methods()).not.toContain('chat.postMessage');
  });

  it('a reply executing before the early stream got going is posted whole, as before (nothing opened)', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    expect(await rm.finish('tc1', 'All at once.')).toBe('Replied (posted).');
    expect(methods()).not.toContain('chat.startStream');
    expect(methods()).not.toContain('chat.delete');
  });

  it('an empty (dropped) reply removes the early stream: stopped, then deleted', async () => {
    const released = vi.fn();
    const rm = new ReplyManager(target({ onSessionReleased: released }));
    rm.open('tc1');
    await sleep(10);
    expect(await rm.finish('tc1', '   ')).toBe(EMPTY_RESULT);
    expect(methods().slice(-2)).toEqual(['chat.stopStream', 'chat.delete']);
    const stop = calls.at(-2)!;
    expect(stop.args).toEqual({ channel: 'D1', ts: expect.stringMatching(/^1700000000\./) });
    expect(stop.opts).toEqual({ idempotencyKey: 'reply:5:0:early-stop' });
    expect(calls.at(-1)!.args).toEqual(stop.args);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('a user stop removes the empty early stream (nothing was visible)', async () => {
    let stopped = false;
    const rm = new ReplyManager(target({ stopRequested: async () => stopped }));
    rm.open('tc1');
    await sleep(10);
    stopped = true;
    expect(await rm.finish('tc1', 'Some text that never shows.')).toMatch(/^Not delivered: the user pressed stop/);
    expect(methods()).toContain('chat.delete');
    expect(methods()).not.toContain('chat.appendStream');
  });

  it('a stop already requested when the call begins opens nothing', async () => {
    const rm = new ReplyManager(target({ stopRequested: async () => true }));
    rm.open('tc1');
    await sleep(10);
    expect(methods()).not.toContain('chat.startStream');
  });

  it('a reply delivered by posting (subagents running) never opens one early', async () => {
    const rm = new ReplyManager(target({ activeRuns: async () => 1 }));
    rm.open('tc1');
    await sleep(10);
    expect(methods()).not.toContain('chat.startStream');
    expect(await rm.finish('tc1', 'Posted whole.')).toBe('Replied (posted).');
    expect(methods()).toContain('chat.postMessage');
    expect(methods()).not.toContain('chat.delete');
  });

  it('a reply whose stream failed is posted whole, after the empty early stream is deleted', async () => {
    failOn = (m) => (m === 'chat.appendStream' ? 'invalid_chunks' : m === 'chat.startStream' && calls.filter((c) => c.method === 'chat.startStream').length > 1 ? 'invalid_chunks' : null);
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'This one cannot stream at all, sadly.';
    await streamIn(rm, text);
    failOn = null;
    expect(await rm.finish('tc1', text)).toBe('Replied (posted).');
    const i = methods();
    expect(i.indexOf('chat.delete')).toBeLessThan(i.indexOf('chat.postMessage'));
    // Refused chunks after an empty start: every reply would pay for it, so early streams switch off.
    expect(earlyStream.enabled).toBe(false);
  });

  it('a channel-specific refusal of the empty start does not switch early streams off', async () => {
    failOn = (m, a) => (m === 'chat.startStream' && !a.chunks ? 'not_in_channel' : null);
    const rm = new ReplyManager(target());
    rm.open('tc1');
    await sleep(10);
    expect(earlyStream.enabled).toBe(true);
    expect(rm.anyVisible).toBe(false);
  });

  it('a Slack-ended (idle) early stream: removed, a fresh stream opens, early streams stay on', async () => {
    failOn = (m, a) => (m === 'chat.appendStream' && a.ts === '1700000000.000001' ? 'message_not_in_streaming_state' : null);
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'Still delivered after the idle stream ended.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    expect(calls.filter((c) => c.method === 'chat.startStream')).toHaveLength(2);
    expect(calls.find((c) => c.method === 'chat.delete')!.args.ts).toBe('1700000000.000001');
    expect(earlyStream.enabled).toBe(true);
  });

  it('a stop landing during the first append opens no fresh stream', async () => {
    let stopped = false;
    failOn = (m) => {
      if (m !== 'chat.appendStream') return null;
      stopped = true;
      return 'message_not_in_streaming_state';
    };
    const rm = new ReplyManager(target({ stopRequested: async () => stopped }));
    rm.open('tc1');
    const text = 'Stopped while this was going out.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toMatch(/^Not delivered: the user pressed stop/);
    expect(calls.filter((c) => c.method === 'chat.startStream')).toHaveLength(1);
    expect(methods()).toContain('chat.delete');
  });

  it('only one caller takes the early stream: an abort racing finish() never deletes the delivered reply', async () => {
    latency = { 'chat.startStream': 60 };
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'Racing an abort.';
    const fin = rm.finish('tc1', text);
    const abort = rm.abortOpenStreams();
    await sleep(5);
    await Promise.all([fin, abort]);
    const deleted = calls.filter((c) => c.method === 'chat.delete').map((c) => c.args.ts);
    const appended = calls.filter((c) => c.method === 'chat.appendStream').map((c) => c.args.ts);
    expect(appended.filter((ts) => deleted.includes(ts))).toEqual([]);
  });

  it('finish() throwing before it removed the early stream: closeUnfinished still deletes it', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    await sleep(10);
    const bad = { n: 1, alt: 'x', get url(): string { throw new Error('boom'); } };
    await expect(rm.finish('tc1', 'With a broken image.', undefined, undefined, undefined, { images: [bad as any] })).rejects.toThrow('boom');
    await rm.closeUnfinished();
    expect(methods().slice(-2)).toEqual(['chat.stopStream', 'chat.delete']);
  });

  it('a retried reply call removes the earlier call\'s unused early stream and opens its own', async () => {
    const rm = new ReplyManager(target({ activityCards: true }));
    rm.open('tc1'); // the model's call fails (invalid input) before any text
    await sleep(10);
    rm.open('tc2');
    await sleep(10);
    const starts = calls.filter((c) => c.method === 'chat.startStream');
    expect(starts).toHaveLength(2);
    expect(calls.find((c) => c.method === 'chat.delete')!.args.ts).toBe('1700000000.000001');
    const json = JSON.stringify({ text: 'The retry goes through.' });
    rm.delta('tc2', json);
    await sleep(300);
    expect(await rm.finish('tc2', 'The retry goes through.')).toBe('Replied (streamed).');
    expect(calls.filter((c) => c.method === 'chat.appendStream').every((c) => c.args.ts === '1700000000.000002')).toBe(true);
  });

  it('chunks refused after an empty start: early streams are switched off, the reply opens a fresh stream', async () => {
    failOn = (m, a) => (m === 'chat.appendStream' && a.ts === '1700000000.000001' ? 'streaming_mode_mismatch' : null);
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'Fallback path, still streamed fine.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    const starts = calls.filter((c) => c.method === 'chat.startStream');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.args.chunks[0].type).toBe('markdown_text');
    expect(starts[1]!.opts).toEqual({ idempotencyKey: 'reply:5:0' });
    expect(calls.find((c) => c.method === 'chat.delete')!.args.ts).toBe('1700000000.000001');
    expect(earlyStream.enabled).toBe(false);
    calls.length = 0;
    new ReplyManager(target({ turnId: 6 })).open('tc9');
    await sleep(10);
    expect(methods()).not.toContain('chat.startStream');
  });

  it('Slack refusing an empty startStream switches early streams off; the reply streams as before', async () => {
    failOn = (m, a) => (m === 'chat.startStream' && !a.chunks ? 'no_text' : null);
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const text = 'Opened with the first text instead.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    expect(earlyStream.enabled).toBe(false);
    expect(calls.filter((c) => c.method === 'chat.startStream').map((c) => Boolean(c.args.chunks))).toEqual([false, true]);
    expect(methods()).not.toContain('chat.delete');
  });

  it('a call that never executes: closeUnfinished deletes the empty early stream', async () => {
    const rm = new ReplyManager(target());
    rm.open('tc1');
    await sleep(10);
    await rm.closeUnfinished();
    expect(methods().slice(-2)).toEqual(['chat.stopStream', 'chat.delete']);
  });

  it('closeStopped and abortOpenStreams delete it too, and an empty early stream does not count as visible', async () => {
    const a = new ReplyManager(target());
    a.open('tc1');
    await sleep(10);
    await a.closeStopped();
    expect(methods().slice(-2)).toEqual(['chat.stopStream', 'chat.delete']);
    calls.length = 0;
    const b = new ReplyManager(target({ turnId: 8 }));
    b.open('tc1');
    await sleep(10);
    expect(b.anyVisible).toBe(false);
    expect(await b.abortOpenStreams('Something went wrong.')).toBe(false);
    expect(methods().slice(-2)).toEqual(['chat.stopStream', 'chat.delete']);
    expect(calls.some((c) => (c.args.chunks ?? []).some((k: any) => k.text?.includes('Something went wrong')))).toBe(false);
  });

  it('an open activity message is adopted as before (no early stream); no activity message opens over an early stream', async () => {
    const rm = new ReplyManager(target({ activityCards: true }));
    rm.activity('Searching the web…');
    await sleep(10);
    rm.open('tc1');
    const text = 'Found it in the docs, here you go.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    await rm.closeActivity();
    expect(methods().filter((m) => m === 'chat.startStream')).toHaveLength(1); // the activity message
    expect(methods()).not.toContain('chat.delete');

    calls.length = 0;
    const r2 = new ReplyManager(target({ activityCards: true, turnId: 9 }));
    r2.open('tc1');
    r2.activity('Reading the page…');
    await sleep(10);
    expect(calls.filter((c) => c.method === 'chat.startStream').every((c) => !c.args.chunks)).toBe(true);
  });

  it('finishText (plain text answer) never opens one early', async () => {
    const rm = new ReplyManager(target());
    expect(await rm.finishText('Plain text answer.')).toMatch(/^Replied/);
    expect(calls.filter((c) => c.method === 'chat.startStream').every((c) => c.args.chunks)).toBe(true);
  });
});
