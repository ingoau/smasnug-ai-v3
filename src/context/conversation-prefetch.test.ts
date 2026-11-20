import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test-key';
  process.env.LOG_LEVEL = 'silent';
});

const store = new Map<string, string>();
vi.mock('../core/redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => (store.set(k, v), 'OK')),
  },
}));
const waiting: (() => void)[] = [];
const release = () => waiting.splice(0).forEach((r) => r());
const slackCall = vi.fn(async (_method: string, args: any) => {
  await new Promise<void>((r) => waiting.push(r));
  return { ok: true, channel: { id: args.channel, is_im: true, user: 'U1' } };
});
vi.mock('../core/slack.js', () => ({ slackCall: (m: string, a: any) => slackCall(m, a), slackErrorCode: () => undefined }));

const { getConversationInfo, prefetchConversationInfo } = await import('./conversation.js');

describe('conversations.info prefetch', () => {
  beforeEach(() => {
    store.clear();
    slackCall.mockClear();
  });

  it('a turn starting while the prefetch runs waits for it (one Slack call), later reads hit the cache', async () => {
    prefetchConversationInfo('D1');
    await vi.waitFor(() => expect(slackCall).toHaveBeenCalledTimes(1));
    const turn = getConversationInfo('D1');
    await new Promise((r) => setTimeout(r, 5));
    expect(slackCall).toHaveBeenCalledTimes(1);
    release();
    expect((await turn)?.kind).toBe('dm');
    expect(await getConversationInfo('D1')).toMatchObject({ kind: 'dm', imUserId: 'U1' });
    expect(slackCall).toHaveBeenCalledTimes(1);
  });

  it('different channels are fetched separately', async () => {
    const a = getConversationInfo('D2');
    const b = getConversationInfo('D3');
    await vi.waitFor(() => expect(slackCall).toHaveBeenCalledTimes(2));
    release();
    expect((await Promise.all([a, b])).map((c) => c?.id)).toEqual(['D2', 'D3']);
  });
});
