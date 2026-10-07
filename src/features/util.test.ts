/** ephemeral(): button answers in a thread go to that thread (chat.postEphemeral), never to the root via response_url. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});

const calls = vi.hoisted(() => [] as { method: string; args: any }[]);
vi.mock('../core/slack.js', () => ({ slackCall: async (method: string, args: any) => void calls.push({ method, args }) }));
vi.mock('../core/slack-fake.js', () => ({ fakeCall: async (method: string, args: any) => void calls.push({ method, args }) }));

const { ephemeral, withThread } = await import('./util.js');

const base = { userId: 'U1', actionId: 'x', responseUrl: 'https://hooks.test/r', body: {} as any };
const ephemeralSource = { container: { type: 'message', is_ephemeral: true } };

beforeEach(() => {
  calls.length = 0;
  process.env.SLACK_FAKE = '1';
});

describe('ephemeral', () => {
  it('a click in a thread: posted in the thread, not via response_url', async () => {
    await ephemeral({ ...base, channelId: 'C1', messageTs: '5.0', threadTs: '1.0' }, 'claim link');
    expect(calls).toEqual([{ method: 'chat.postEphemeral', args: { channel: 'C1', user: 'U1', text: 'claim link', thread_ts: '1.0' } }]);
  });

  it('replace on an ephemeral in a thread: removes it, posts the text in the thread', async () => {
    await ephemeral({ ...base, channelId: 'D1', messageTs: '5.0', body: ephemeralSource }, 'Cancelled.', { replace: true, threadTs: '1.0' });
    expect(calls).toEqual([
      { method: 'response_url', args: { url: 'https://hooks.test/r', delete_original: true } },
      { method: 'chat.postEphemeral', args: { channel: 'D1', user: 'U1', text: 'Cancelled.', thread_ts: '1.0' } },
    ]);
  });

  it('replace on a regular message in a thread: replaced in place', async () => {
    await ephemeral({ ...base, channelId: 'C1', messageTs: '5.0', threadTs: '1.0' }, 'Done', { replace: true });
    expect(calls).toEqual([{ method: 'response_url', args: { url: 'https://hooks.test/r', replace_original: true, text: 'Done' } }]);
  });

  it('outside a thread (or on the thread parent itself): response_url as before', async () => {
    await ephemeral({ ...base, channelId: 'C1', messageTs: '1.0', threadTs: '1.0' }, 'hi');
    await ephemeral({ ...base, channelId: 'C1', messageTs: '2.0' }, 'hey');
    expect(calls.map((c) => [c.method, c.args.text, c.args.response_type])).toEqual([
      ['response_url', 'hi', 'ephemeral'],
      ['response_url', 'hey', 'ephemeral'],
    ]);
  });
});

describe('withThread', () => {
  it('fills the thread from a row when the payload has none; keeps a payload thread; ignores another channel', () => {
    const ctx = { ...base, channelId: 'C1', messageTs: '5.0' };
    expect(withThread(ctx, 'C1:1.0')).toMatchObject({ channelId: 'C1', threadTs: '1.0' });
    expect(withThread({ ...base, messageTs: '5.0' }, 'D9:2.0')).toMatchObject({ channelId: 'D9', threadTs: '2.0' });
    expect(withThread({ ...ctx, threadTs: '3.0' }, 'C1:1.0').threadTs).toBe('3.0');
    expect(withThread(ctx, 'C2:1.0').threadTs).toBeUndefined();
    expect(withThread(ctx, null)).toBe(ctx);
  });
});
