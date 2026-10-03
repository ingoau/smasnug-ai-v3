/** TurnStatus: show-on-first-activity, coalescing, stop handling and clearing (fake transport, fake timers). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test-key';
  process.env.LOG_LEVEL = 'silent';
});
vi.mock('../core/slack.js', () => ({ slackCall: vi.fn(), slackErrorCode: (err: any) => err?.data?.error }));

const { TurnStatus, statusPhrase } = await import('./session-status.js');

function make(opts: { mode?: 'overlay' | 'text' | 'off'; stopped?: () => Promise<boolean>; failText?: boolean } = {}) {
  const calls: string[] = [];
  const status = new TurnStatus({
    channelId: 'C1',
    threadTs: '1.1',
    userId: 'U1',
    mode: opts.mode ?? 'overlay',
    stopped: opts.stopped,
    transport: {
      lifecycle: async (s) => void calls.push(s),
      text: async (t) => {
        calls.push(`text:${t}`);
        if (opts.failText) throw new Error('boom');
      },
    },
  });
  return { status, calls };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('TurnStatus', () => {
  it('shows nothing and clears nothing when no activity happened (unmentioned turn, direct reply)', async () => {
    const { status, calls } = make();
    await status.finish();
    expect(calls).toEqual([]);
    expect(status.isShown).toBe(false);
  });

  it('first activity shows the status right away; finish clears text then sets active', async () => {
    const { status, calls } = make();
    status.setActivity('Searching Slack…');
    await settle();
    expect(calls).toEqual(['processing', 'text:Searching Slack…']);
    await status.finish();
    expect(calls).toEqual(['processing', 'text:Searching Slack…', 'text:', 'active']);
  });

  it('start() shows the initial text (mention turns)', async () => {
    const { status, calls } = make();
    await status.start();
    expect(calls).toEqual(['processing', 'text:Thinking…']);
  });

  it('coalesces updates to one per second, latest text wins, unchanged text is skipped', async () => {
    const { status, calls } = make();
    await status.start();
    status.setActivity('Searching the web…');
    status.setActivity('Reading the page…');
    status.setActivity('Reading the thread…');
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(['processing', 'text:Thinking…']);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toEqual(['processing', 'text:Thinking…', 'text:Reading the thread…']);
    status.setActivity('Reading the thread…'); // unchanged
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    status.setActivity('Searching Slack…'); // > 1s since the last update: immediate
    await settle();
    expect(calls.at(-1)).toBe('text:Searching Slack…');
  });

  it('an activity the turn ends before it could be sent is dropped (no flash)', async () => {
    const { status, calls } = make();
    status.setActivity('Searching Slack…');
    await status.finish();
    expect(calls).toEqual([]);
  });

  it('a pending update is dropped when the turn finishes', async () => {
    const { status, calls } = make();
    await status.start();
    status.setActivity('Reading the page…');
    await status.finish();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual(['processing', 'text:Thinking…', 'text:', 'active']);
    status.setActivity('Late…');
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(4);
    await status.finish(); // idempotent
    expect(calls).toHaveLength(4);
  });

  it('after a native stop nothing re-sets processing; finish still sets active', async () => {
    let stopped = false;
    const { status, calls } = make({ stopped: async () => stopped });
    stopped = true;
    status.setActivity('Searching Slack…');
    await settle();
    expect(calls).toEqual([]);
    await status.finish();
    expect(calls).toEqual([]); // never shown: the stop handler already set active

    stopped = false;
    const b = make({ stopped: async () => stopped });
    await b.status.start();
    stopped = true;
    await vi.advanceTimersByTimeAsync(1500);
    b.status.setActivity('Reading the page…');
    await vi.advanceTimersByTimeAsync(1500);
    expect(b.calls).toEqual(['processing', 'text:Thinking…']);
    await b.status.finish();
    expect(b.calls).toEqual(['processing', 'text:Thinking…', 'text:', 'active']);
  });

  it('modes: text sends no processing; off sends no text', async () => {
    const t = make({ mode: 'text' });
    t.status.setActivity('Searching Slack…');
    await settle();
    await t.status.finish();
    expect(t.calls).toEqual(['text:Searching Slack…', 'text:', 'active']);
    const o = make({ mode: 'off' });
    o.status.setActivity('Searching Slack…');
    await vi.advanceTimersByTimeAsync(1500);
    o.status.setActivity('Reading the page…');
    await o.status.finish();
    expect(o.calls).toEqual(['processing', 'active']);
  });

  it('never throws when a Slack call fails', async () => {
    const { status, calls } = make({ failText: true });
    await expect(status.start()).resolves.toBeUndefined();
    await expect(status.finish()).resolves.toBeUndefined();
    expect(calls).toEqual(['processing', 'text:Thinking…', 'text:', 'active']);
  });

  it('statusPhrase prefixes "is" for the app-name form', () => {
    expect(statusPhrase('Searching the web…')).toBe('is searching the web…');
    expect(statusPhrase('')).toBe('');
  });
});
