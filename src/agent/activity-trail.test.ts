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
const { ReplyManager, editRetry } = await import('./reply.js');
editRetry.delaysMs = [5, 5];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const methods = () => calls.map((c) => c.method);
/** Each card's last status over every call (start / append / stop), i.e. what Slack shows once the stream stopped. */
const finalStatuses = () => {
  const out: Record<string, string> = {};
  for (const c of calls) for (const k of c.args.chunks ?? []) if (k.type === 'task_update') out[k.id] = k.status;
  return out;
};
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
  it('first activity opens a plan-mode stream holding one in-progress task; updates are coalesced, unchanged text skipped', async () => {
    const t = trail();
    t.activity('Searching the web…');
    await sleep(10);
    expect(methods()).toEqual(['chat.startStream']);
    expect(calls[0]!.args).toMatchObject({ channel: 'D1', thread_ts: '1.1', recipient_user_id: 'U1', recipient_team_id: 'T1', task_display_mode: 'plan' });
    expect(calls[0]!.args.chunks).toEqual([
      { type: 'plan_update', title: 'Working…' },
      { type: 'task_update', id: 'activity-1', title: 'Searching the web…', status: 'in_progress' },
    ]);
    t.activity('Reading the page…'); // superseded within the window
    t.activity('Searching Slack…');
    t.activity('Searching Slack…');
    await sleep(150);
    expect(cardsOf('chat.appendStream')).toEqual([['Searching the web…:complete', 'Searching Slack…:in_progress']]);
    t.activity('Searching Slack…'); // unchanged
    await sleep(150);
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream']);
  });

  it('close() at the end of a silent turn stops (card finished, never left in progress) and deletes the message', async () => {
    const released = vi.fn();
    const t = trail({ released });
    t.activity('Searching Slack…');
    await sleep(10);
    await t.close();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.delete']);
    expect(calls[1]!.args.chunks).toEqual([{ type: 'task_update', id: 'activity-1', title: 'Searching Slack…', status: 'complete' }]);
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
    t.activity('Digging in…');
    await sleep(10);
    expect(methods()).toEqual(['chat.startStream', 'chat.startStream']);
    await t.close();
    expect(methods()).toEqual(['chat.startStream', 'chat.startStream', 'chat.stopStream', 'chat.delete']);
    expect(calls[3]!.args.ts).not.toBe(a!.ts);
  });

  it("a card completes when its tool call returns (parallel calls: when the last one does); the stop then has nothing to finish", async () => {
    const t = trail();
    t.activity('Searching the web…', 'a');
    t.activity('Searching the web…', 'b'); // same card
    await sleep(10);
    t.toolDone('a');
    await sleep(150);
    expect(methods()).toEqual(['chat.startStream']); // b still running
    t.toolDone('b');
    await sleep(150);
    expect(cardsOf('chat.appendStream')).toEqual([['Searching the web…:complete']]);
    await t.close();
    expect(calls.find((c) => c.method === 'chat.stopStream')!.args.chunks).toBeUndefined();
    expect(finalStatuses()).toEqual({ 'activity-1': 'complete' });
  });

  it('only a call that really failed gives its card the error status; a later card keeps going', async () => {
    const t = trail();
    t.activity('Reading the page…', 'f1');
    await sleep(10);
    t.toolDone('f1', false);
    t.activity('Searching the web…', 'w1');
    await sleep(150);
    expect(cardsOf('chat.appendStream')).toEqual([['Reading the page…:error', 'Searching the web…:in_progress']]);
    const a = await t.adopt();
    expect(a!.chunks).toEqual([{ type: 'task_update', id: 'activity-2', title: 'Searching the web…', status: 'complete' }]);
  });

  it('parallel tools: an earlier card stays in progress while its call runs, and is finished at the stop', async () => {
    const t = trail();
    t.activity('Searching the web…', 'w1');
    await sleep(10);
    t.activity('Reading the page…', 'f1');
    await sleep(150);
    expect(cardsOf('chat.appendStream')).toEqual([['Reading the page…:in_progress']]);
    await t.discard();
    expect(cardsOf('chat.stopStream')).toEqual([['Searching the web…:complete', 'Reading the page…:complete']]);
  });

  it('a tool that returns before its card went out shows no card (e.g. an instant spawn)', async () => {
    const t = trail();
    t.activity('Searching Slack…', 'x');
    await sleep(10);
    t.activity('Digging in…', 's1');
    t.toolDone('s1');
    await sleep(150);
    expect(methods()).toEqual(['chat.startStream']);
    t.toolDone('x');
    t.activity('Digging in…', 's2');
    t.toolDone('s2');
    await sleep(150);
    expect(cardsOf('chat.appendStream')).toEqual([['Searching Slack…:complete']]);
    const fresh = trail();
    fresh.activity('Digging in…', 's3');
    fresh.toolDone('s3'); // before the first flush ran
    await sleep(20);
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream']);
    await fresh.close();
  });

  it('a stop Slack refuses with the chunks is retried plainly, then the message is deleted', async () => {
    const t = trail();
    t.activity('Searching Slack…');
    await sleep(10);
    failOn = (m, a) => (m === 'chat.stopStream' && a.chunks ? 'invalid_chunks' : null);
    await t.close();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.stopStream', 'chat.delete']);
    expect(calls[2]!.args.chunks).toBeUndefined();
  });

  it('Slack refusing a cards-only stream turns activity off for the turn (the status still shows Working…)', async () => {
    failOn = (m) => (m === 'chat.startStream' ? 'invalid_chunks' : null);
    const t = trail();
    t.activity('Searching Slack…');
    await sleep(10);
    t.activity('Reading the page…');
    await sleep(150);
    expect(methods()).toEqual(['chat.startStream', 'chat.startStream']); // plan mode, then timeline
    expect(await t.adopt()).toBeNull();
    await t.close();
    expect(methods()).toEqual(['chat.startStream', 'chat.startStream']);
  });

  it('a refused plan display falls back to timeline task cards', async () => {
    failOn = (m, a) => (m === 'chat.startStream' && a.task_display_mode ? 'invalid_arguments' : null);
    const t = trail();
    t.activity('Searching Slack…');
    await sleep(10);
    expect(methods()).toEqual(['chat.startStream', 'chat.startStream']);
    expect(calls[1]!.args.task_display_mode).toBeUndefined();
    expect(calls[1]!.args.chunks).toEqual([{ type: 'task_update', id: 'activity-1', title: 'Searching Slack…', status: 'in_progress' }]);
    expect(t.isOpen).toBe(true);
  });

  it('after a native stop nothing new is opened', async () => {
    const t = trail({ stopped: async () => true });
    t.activity('Searching Slack…');
    await sleep(10);
    await t.close();
    expect(calls).toEqual([]);
  });

  it('crash safety: the open message is recorded while the trail holds it (until adopted or removed)', async () => {
    const log: string[] = [];
    const mk = () =>
      new ActivityTrail({
        channelId: 'D1',
        threadTs: '1.1',
        turnId: 7,
        recipientUserId: 'U1',
        teamId: async () => 'T1',
        onOpened: async (ts) => void log.push(`open ${ts}`),
        onClosed: async () => void log.push('closed'),
      });
    const t = mk();
    t.activity('Searching Slack…');
    await sleep(10);
    const a = await t.adopt();
    expect(log).toEqual([`open ${a!.ts}`, 'closed']);
    log.length = 0;
    const t2 = mk();
    t2.activity('Searching Slack…');
    await sleep(10);
    await t2.close();
    expect(log).toEqual([expect.stringMatching(/^open /), 'closed']);
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

  it('a posted reply (subagents running) is written into the activity message, its task finished at the stop', async () => {
    const rm = new ReplyManager(target(1));
    rm.activity('Updating the task…');
    await sleep(10);
    await rm.finish('tc1', 'Told the subagent.');
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.update']);
    expect(cardsOf('chat.stopStream')).toEqual([['Updating the task…:complete']]);
    const ts = calls[1]!.args.ts;
    expect(calls[2]!.args).toMatchObject({ ts, text: 'Told the subagent.', blocks: [{ type: 'markdown', text: 'Told the subagent.' }] });
    expect(rm.lastDelivered).toEqual({ ts, text: 'Told the subagent.', streamed: false });
  });

  it('…and when the activity message cannot take it, it is deleted before the reply is posted (never above it)', async () => {
    const rm = new ReplyManager(target(1));
    rm.activity('Updating the task…');
    await sleep(10);
    failOn = (m) => (m === 'chat.update' ? 'cant_update_message' : null);
    await rm.finish('tc1', 'Told the subagent.');
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.update', 'chat.stopStream', 'chat.delete', 'chat.postMessage']);
    expect(finalStatuses()).toEqual({ 'activity-1': 'complete' });
  });

  it('a posted reply into an activity stream Slack already ended: still written into it (no delete + post gap)', async () => {
    const rm = new ReplyManager(target(1));
    rm.activity('Updating the task…');
    await sleep(10);
    failOn = (m) => (m === 'chat.stopStream' ? 'message_not_in_streaming_state' : null);
    await rm.finish('tc1', 'Told the subagent.');
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.update']);
    expect(methods()).not.toContain('chat.delete');
    expect(rm.lastDelivered).toMatchObject({ ts: calls[1]!.args.ts, text: 'Told the subagent.', streamed: false });
  });

  it('the turn card goes above a posted reply and is recorded with its message', async () => {
    const attached: string[] = [];
    const card = { type: 'plan', block_id: 'card_5_plan', title: 'Task 1', tasks: [] } as const;
    const rm = new ReplyManager(target(1, { card: { block: async () => card, attached: async (ts: string) => void attached.push(ts) } }));
    await rm.finish('tc1', 'On it.');
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args.blocks.map((b: any) => b.type)).toEqual(['plan', 'markdown']);
    expect(attached).toEqual([rm.lastDelivered!.ts]);
  });

  it('the final layout of a streamed reply keeps the turn card above it', async () => {
    const attached: string[] = [];
    const card = { type: 'plan', block_id: 'card_5_plan', title: 'Searched the web', tasks: [{ type: 'task_card', task_id: 'step_1', title: 'Searched the web', status: 'complete' }] } as const;
    const rm = new ReplyManager(target(0, { card: { block: async () => card, attached: async (ts: string) => void attached.push(ts) } }));
    rm.activity('Searching the web…', 'w1');
    await sleep(10);
    rm.activityDone('w1');
    const text = 'Found it: the answer is 42, according to the docs.';
    await streamIn(rm, text);
    await rm.finish('tc1', text);
    const update = calls.find((c) => c.method === 'chat.update')!;
    expect(update.args.blocks).toEqual([card, { type: 'markdown', text }]);
    expect(attached).toEqual([update.args.ts]);
  });

  it('reply + spawn in one step (posted whole): the spawn card completes on its result; nothing in progress or failed at the stop', async () => {
    const rm = new ReplyManager(target(1));
    rm.activity('Digging in…', 's1');
    await sleep(10);
    rm.activityDone('s1');
    await rm.finish('tc1', 'On it.');
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.update']);
    expect(finalStatuses()).toEqual({ 'activity-1': 'complete' });
    expect(cardsOf('chat.stopStream')).toEqual([['Digging in…:complete']]);
  });

  it('reply + spawn in one step (streamed): the reply adopts the finished card; nothing in progress or failed at the stop', async () => {
    const rm = new ReplyManager(target(0));
    rm.activity('Digging in…', 's1');
    await sleep(10);
    rm.activityDone('s1');
    const text = 'On it, a subagent is looking into it.';
    await streamIn(rm, text);
    expect(await rm.finish('tc1', text)).toBe('Replied (streamed).');
    await rm.closeActivity();
    expect([...new Set(methods())]).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.update']);
    expect(finalStatuses()).toEqual({ 'activity-1': 'complete' });
  });

  it('no new activity message opens while a reply is being posted', async () => {
    const rm = new ReplyManager(target(1));
    const done = rm.finish('tc1', 'On it.');
    await new Promise((r) => setImmediate(r)); // the post is under way
    rm.activity('Digging in…', 's1');
    await done;
    await sleep(20);
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.postMessage']);
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

  it('a message posted after the activity message (postedSince): the reply gets a message of its own below it', async () => {
    const seen: string[] = [];
    const rm = new ReplyManager(target(0, { postedSince: async (ts: string) => (seen.push(ts), true) }));
    rm.activity('Searching the web…');
    await sleep(10);
    const activityTs = calls[0]!.args && '1700000000.00000' + n;
    await rm.finish('tc1', 'The answer.');
    await rm.closeActivity();
    expect(seen).toEqual([activityTs]);
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.delete', 'chat.startStream', 'chat.stopStream']);
    expect(calls[2]!.args.ts).toBe(activityTs);
    expect(calls[3]!.args.chunks.every((c: any) => c.type !== 'task_update')).toBe(true);
    expect(rm.lastDelivered!.ts).not.toBe(activityTs);
  });

  it('the turn posting in the thread itself (send_message) also keeps the reply out of the activity message', async () => {
    const rm = new ReplyManager(target(0, { postedSince: async () => false }));
    rm.activity('Preparing a message…');
    await sleep(10);
    rm.notePostedInThread();
    await rm.finish('tc1', 'Sent it.');
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.startStream', 'chat.stopStream', 'chat.delete', 'chat.startStream', 'chat.stopStream']);
  });

  it('the final layout is retried while Slack still counts the message as streaming', async () => {
    let conflicts = 2;
    const rm = new ReplyManager(target());
    rm.activity('Reading the page…');
    await sleep(10);
    failOn = (m) => (m === 'chat.update' && conflicts-- > 0 ? 'streaming_state_conflict' : null);
    expect(await rm.finish('tc1', 'Short answer.')).toBe('Replied (streamed).');
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.update', 'chat.update', 'chat.update']);
  });

  it('a non-transient chat.update error is not retried', async () => {
    const rm = new ReplyManager(target());
    rm.activity('Reading the page…');
    await sleep(10);
    failOn = (m) => (m === 'chat.update' ? 'message_not_found' : null);
    await rm.finish('tc1', 'Short answer.');
    expect(methods().filter((m) => m === 'chat.update')).toHaveLength(1);
  });

  it('a reply stream whose tool call never executed is closed at turn end (cards with it)', async () => {
    const rm = new ReplyManager(target());
    rm.activity('Searching the web…');
    await sleep(10);
    const json = JSON.stringify({ text: 'A first attempt at the answer' });
    rm.delta('bad', json.slice(0, -5)); // the call is cut off / invalid: never executed
    await sleep(200);
    const activityTs = calls.find((c) => c.method === 'chat.appendStream')!.args.ts;
    await rm.closeUnfinished();
    // kept with its visible text, cards dropped (no other reply was delivered)
    expect(methods()).toEqual(['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.update']);
    expect(calls.at(-1)!.args).toMatchObject({ ts: activityTs, text: 'A first attempt at the ans' });
    await rm.closeUnfinished(); // idempotent
    expect(methods()).toHaveLength(4);
  });

  it('…and deleted when the retried call delivered the reply; pending deltas never open a stream after the turn', async () => {
    const rm = new ReplyManager(target());
    rm.delta('bad', JSON.stringify({ text: 'A first attempt at the answer' }).slice(0, -5));
    await sleep(200);
    await rm.finish('good', 'The answer.');
    rm.delta('late', '{"text":"Something more to say');
    await rm.closeUnfinished();
    await sleep(150);
    expect(methods()).toEqual(['chat.startStream', 'chat.postMessage', 'chat.stopStream', 'chat.delete']);
  });

  it('no activity message once a reply is visible', async () => {
    const rm = new ReplyManager(target());
    await rm.finish('tc1', 'Done, noted.');
    rm.activity('Saving a note…');
    await sleep(20);
    await rm.closeActivity();
    expect(methods()).toEqual(['chat.postMessage']);
  });

  it('without activityCards nothing is shown', async () => {
    const rm = new ReplyManager({ ...target(), activityCards: false });
    rm.activity('Searching Slack…');
    await sleep(10);
    await rm.closeActivity();
    expect(calls).toEqual([]);
  });
});
