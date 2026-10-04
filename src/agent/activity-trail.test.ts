/** Activity trail: transient task cards for tool activity, adopted by the reply stream or deleted. */
import '../tools/test-env.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; args: any }[] = [];
let failOn: ((method: string, args: any) => string | null) | null = null;
let n = 0;
vi.mock('../core/slack.js', () => ({
  slackCall: vi.fn(async (method: string, args: any) => {
    calls.push({ method, args });
    const code = failOn?.(method, args);
    if (code) throw Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
    if (method === 'chat.startStream' || method === 'chat.postMessage') return { ok: true, ts: `1700000000.00000${++n}` };
    return { ok: true, ts: args.ts, team_id: 'T1' };
  }),
  slackErrorCode: (err: any) => err?.data?.error,
}));
vi.mock('../core/events.js', () => ({ appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}) }));

const { ActivityTrail } = await import('./activity-trail.js');
const { ReplyManager } = await import('./reply.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const methods = () => calls.map((c) => c.method);
const cardsOf = (method: string) =>
  calls.filter((c) => c.method === method).map((c) => (c.args.chunks ?? []).filter((k: any) => k.type === 'task_update').map((k: any) => `${k.title}:${k.status}`));

function trail(opts: { stopped?: () => Promise<boolean>; released?: () => void } = {}) {
  return new ActivityTrail({
    channelId: 'D1',
    threadTs: '1.1',
    turnId: 7,
    recipientUserId: 'U1',
    teamId: async () => 'T1',
    stopRequested: opts.stopped,
    onSessionReleased: opts.released,
    minIntervalMs: 100,
  });
}

beforeEach(() => {
  calls.length = 0;
  failOn = null;
});

describe('ActivityTrail', () => {
  it('first activity opens a stream holding one in-progress task card; updates are coalesced, unchanged text skipped', async () => {
    const t = trail();
    t.activity('Searching the web…');
    await sleep(10);
    expect(methods()).toEqual(['chat.startStream']);
    expect(calls[0]!.args).toMatchObject({ channel: 'D1', thread_ts: '1.1', recipient_user_id: 'U1', recipient_team_id: 'T1' });
    expect(calls[0]!.args.chunks).toEqual([{ type: 'task_update', id: 'activity-1', title: 'Searching the web…', status: 'in_progress' }]);
    t.activity('Reading the page…'); // superseded within the window
    t.activity('Searching Slack…');
    t.activity('Searching Slack…');
    await sleep(150);
    expect(cardsOf('chat.appendStream')).toEqual([['Searching the web…:complete', 'Searching Slack…:in_progress']]);
    t.activity('Searching Slack…'); // unchanged
    await sleep(150);
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream']);
  });

  it('close() at the end of a silent turn stops and deletes the message (nothing left behind)', async () => {
    const released = vi.fn();
    const t = trail({ released });
    t.activity('Searching Slack…');
    await sleep(10);
    await t.close();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.delete']);
    expect(calls[2]!.args).toEqual({ channel: 'D1', ts: calls[1]!.args.ts });
    expect(released).toHaveBeenCalledTimes(1);
    t.activity('Late…');
    await sleep(150);
    expect(methods()).toHaveLength(3);
  });

  it('an activity the turn ends (or a reply starts) before it went out is dropped: no flash', async () => {
    const t = trail();
    t.activity('Searching Slack…');
    expect(await t.adopt()).toBeNull();
    await t.close();
    expect(calls).toEqual([]);
  });

  it('adopt() hands over the open message and the chunk completing its card; later activity opens a new one', async () => {
    const t = trail();
    t.activity('Searching Slack…');
    await sleep(10);
    const a = await t.adopt();
    expect(a).toEqual({ ts: expect.stringMatching(/^1700000000\./), chunks: [{ type: 'task_update', id: 'activity-1', title: 'Searching Slack…', status: 'complete' }], cards: 1, stopKey: 'activity:7:0:stop' });
    expect(t.isOpen).toBe(false);
    t.activity('Starting a subagent…');
    await sleep(10);
    expect(methods()).toEqual(['chat.startStream', 'chat.startStream']);
    await t.close();
    expect(methods()).toEqual(['chat.startStream', 'chat.startStream', 'chat.stopStream', 'chat.delete']);
    expect(calls[3]!.args.ts).not.toBe(a!.ts);
  });

  it('Slack refusing a cards-only stream turns activity off for the turn (the status still shows Working…)', async () => {
    failOn = (m) => (m === 'chat.startStream' ? 'invalid_chunks' : null);
    const t = trail();
    t.activity('Searching Slack…');
    await sleep(10);
    t.activity('Reading the page…');
    await sleep(150);
    expect(methods()).toEqual(['chat.startStream']);
    expect(await t.adopt()).toBeNull();
    await t.close();
    expect(methods()).toEqual(['chat.startStream']);
  });

  it('after a native stop nothing new is opened', async () => {
    const t = trail({ stopped: async () => true });
    t.activity('Searching Slack…');
    await sleep(10);
    await t.close();
    expect(calls).toEqual([]);
  });

  it('a halted stream (append fails) is not adopted and gets deleted at the end', async () => {
    const t = trail();
    t.activity('Searching Slack…');
    await sleep(10);
    failOn = (m) => (m === 'chat.appendStream' ? 'message_not_in_streaming_state' : null);
    t.activity('Reading the page…');
    await sleep(150);
    expect(await t.adopt()).toBeNull();
    failOn = null;
    await t.close();
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.delete']);
  });
});

describe('ReplyManager with activity cards', () => {
  const target = (runs = 0, extra: Record<string, unknown> = {}) => ({
    threadId: 'D1:1.1',
    channelId: 'D1',
    threadTs: '1.1',
    turnId: 3,
    turnKind: 'user' as const,
    recipientUserId: 'U1',
    activeRuns: async () => runs,
    activityCards: true,
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

  it('the reply streams into the open activity message; the final layout drops the cards', async () => {
    const released = vi.fn();
    const rm = new ReplyManager(target(0, { onSessionReleased: released }));
    rm.activity('Searching the web…');
    await sleep(10);
    const text = 'Found it: the answer is 42, according to the docs.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    await rm.closeActivity();
    expect(methods().filter((m) => m === 'chat.startStream')).toHaveLength(1); // one message for cards + reply
    const appends = calls.filter((c) => c.method === 'chat.appendStream');
    expect(appends[0]!.args.chunks[0]).toEqual({ type: 'task_update', id: 'activity-1', title: 'Searching the web…', status: 'complete' });
    expect(appends[0]!.args.chunks[1].type).toBe('markdown_text');
    const ts = calls.find((c) => c.method === 'chat.stopStream')!.args.ts;
    const update = calls.find((c) => c.method === 'chat.update')!;
    expect(update.args).toMatchObject({ channel: 'D1', ts, text, blocks: [{ type: 'markdown', text }] });
    expect(methods()).not.toContain('chat.delete');
    expect(released).toHaveBeenCalledTimes(1);
    expect(rm.lastDelivered).toEqual({ ts, text, streamed: true });
  });

  it('a reply finished without deltas still takes over the activity message', async () => {
    const rm = new ReplyManager(target());
    rm.activity('Reading the page…');
    await sleep(10);
    await rm.finish('tc1', 'Short answer.');
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.update']);
  });

  it('a posted reply (subagents running) deletes the activity message', async () => {
    const rm = new ReplyManager(target(1));
    rm.activity('Updating a subagent…');
    await sleep(10);
    await rm.finish('tc1', 'Told the subagent.');
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.postMessage', 'chat.stopStream', 'chat.delete']);
  });

  it('error before any reply: the activity message is deleted, nothing else changes', async () => {
    const rm = new ReplyManager(target());
    rm.activity('Searching Slack…');
    await sleep(10);
    expect(await rm.abortOpenStreams('_Something broke_')).toBe(false);
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.delete']);
  });

  it('error mid-reply: the cards are dropped, the visible text and the note stay', async () => {
    const rm = new ReplyManager(target());
    rm.activity('Searching Slack…');
    await sleep(10);
    await streamIn(rm, 'Partial answer so far');
    expect(await rm.abortOpenStreams('_Something broke_')).toBe(true);
    const update = calls.find((c) => c.method === 'chat.update')!;
    expect(update.args.text).toBe('Partial answer so far\n\n_Something broke_');
  });

  it('an adopted activity stream Slack already ended is replaced by a fresh stream: the reply is delivered', async () => {
    n = 0; // the activity message gets ts …001
    const dead = '1700000000.000001';
    const rm = new ReplyManager(target(0, { stopRequested: async () => false }));
    rm.activity('Searching the web…');
    await sleep(10);
    failOn = (m, a) => (m === 'chat.appendStream' && a.ts === dead ? 'message_not_in_streaming_state' : null);
    const text = 'Here is the answer you asked for, with details.';
    rm.start('c1');
    rm.delta('c1', JSON.stringify({ text }).slice(0, -2));
    await sleep(200);
    expect(await rm.finish('c1', text)).toMatch(/^Replied \(streamed\)/);
    await rm.closeActivity();
    // The dead activity message is stopped and deleted; the reply streams into a new message of its own.
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.delete', 'chat.startStream', 'chat.stopStream']);
    expect(calls[3]!.args.ts).toBe(dead);
    const replyTs = calls.at(-1)!.args.ts;
    expect(replyTs).not.toBe(dead);
    expect(rm.lastDelivered).toMatchObject({ ts: replyTs, text, streamed: true });
  });

  it('an adopted activity stream halted by a user stop: nothing delivered, the message is removed', async () => {
    let checks = 0;
    // false for the activity and the reply's pre-send check, true once the append into the adopted message failed
    const rm = new ReplyManager(target(0, { stopRequested: async () => ++checks >= 3 }));
    rm.activity('Searching the web…');
    await sleep(10);
    failOn = (m) => (m === 'chat.appendStream' ? 'message_not_in_streaming_state' : null);
    const text = 'Here is the answer you asked for, with details.';
    rm.delta('c1', JSON.stringify({ text }).slice(0, -2));
    await sleep(200);
    expect(await rm.finish('c1', text)).toMatch(/^Not delivered: the user pressed stop/);
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.delete']);
  });

  it('without activityCards nothing is shown', async () => {
    const rm = new ReplyManager({ ...target(), activityCards: false });
    rm.activity('Searching Slack…');
    await sleep(10);
    await rm.closeActivity();
    expect(calls).toEqual([]);
  });
});
