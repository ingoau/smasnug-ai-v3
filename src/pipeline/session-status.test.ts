/** TurnStatus: show-on-first-activity, re-show after a released session, stop handling and final statuses. */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test-key';
  process.env.LOG_LEVEL = 'silent';
});
vi.mock('../core/slack.js', () => ({ slackCall: vi.fn(), slackErrorCode: (err: any) => err?.data?.error }));

const { TurnStatus } = await import('./session-status.js');

function make(opts: { stopped?: () => Promise<boolean>; fail?: boolean } = {}) {
  const calls: string[] = [];
  const status = new TurnStatus({
    channelId: 'C1',
    threadTs: '1.1',
    userId: 'U1',
    stopped: opts.stopped,
    transport: {
      lifecycle: async (s) => {
        calls.push(s);
        if (opts.fail) throw new Error('boom');
      },
    },
  });
  return { status, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('TurnStatus', () => {
  it('shows nothing and clears nothing when no activity happened (unmentioned turn, direct reply)', async () => {
    const { status, calls } = make();
    await status.finish();
    expect(calls).toEqual([]);
    expect(status.isShown).toBe(false);
  });

  it('first activity sets processing once (a burst of tools sends one call); finish sets active', async () => {
    const { status, calls } = make();
    status.setActivity('Searching Slack…');
    status.setActivity('Reading the page…');
    await settle();
    expect(calls).toEqual(['processing']);
    expect(status.isShown).toBe(true);
    await status.finish();
    expect(calls).toEqual(['processing', 'active']);
  });

  it('adopt() takes over an indicator shown at intake: no calls, but finish() clears it', async () => {
    const { status, calls } = make();
    status.adopt();
    status.setActivity('Searching Slack…');
    await settle();
    expect(calls).toEqual([]);
    await status.finish();
    expect(calls).toEqual(['active']);
  });

  it('start() shows it right away (mention turns)', async () => {
    const { status, calls } = make();
    await status.start();
    expect(calls).toEqual(['processing']);
  });

  it('after released() (a reply stream ended: Slack set active) the next activity sets processing again', async () => {
    const { status, calls } = make();
    await status.start();
    status.setActivity('Searching Slack…'); // still processing: nothing to do
    await settle();
    status.released();
    await settle();
    expect(calls).toEqual(['processing']);
    status.setActivity('Reading the page…');
    status.setActivity('Reading the thread…');
    await settle();
    expect(calls).toEqual(['processing', 'processing']);
    await status.finish();
    expect(calls).toEqual(['processing', 'processing', 'active']);
  });

  it('nothing after finish; finish is idempotent', async () => {
    const { status, calls } = make();
    await status.start();
    await status.finish();
    status.released();
    status.setActivity('Late…');
    await settle();
    await status.finish();
    expect(calls).toEqual(['processing', 'active']);
  });

  it('after a native stop nothing re-sets processing', async () => {
    let stopped = true;
    const a = make({ stopped: async () => stopped });
    a.status.setActivity('Searching Slack…');
    await settle();
    await a.status.finish();
    expect(a.calls).toEqual([]); // never shown: the stop handler already set active

    stopped = false;
    const b = make({ stopped: async () => stopped });
    await b.status.start();
    stopped = true;
    b.status.released();
    b.status.setActivity('Reading the page…');
    await settle();
    expect(b.calls).toEqual(['processing']);
    await b.status.finish();
    expect(b.calls).toEqual(['processing', 'active']);
  });

  it('final status: suspended / closed replace active, and apply even when nothing was shown', async () => {
    const a = make();
    await a.status.start();
    await a.status.finish('suspended');
    expect(a.calls).toEqual(['processing', 'suspended']);
    const b = make();
    await b.status.finish('closed');
    expect(b.calls).toEqual(['closed']);
  });

  it('never throws when a Slack call fails', async () => {
    const { status, calls } = make({ fail: true });
    await expect(status.start()).resolves.toBeUndefined();
    await expect(status.finish()).resolves.toBeUndefined();
    expect(calls).toEqual(['processing', 'active']);
  });
});
