import '../tools/test-env.js';
import { describe, expect, it, vi } from 'vitest';

const calls: { method: string; args: any }[] = [];
vi.mock('../core/slack.js', () => ({
  slackCall: vi.fn(async (method: string, args: any) => {
    calls.push({ method, args });
    return { ok: true, ts: '1700000000.000900' };
  }),
  slackErrorCode: (err: any) => err?.data?.error,
}));
vi.mock('../core/events.js', async (orig) => ({ ...(await orig<typeof import('../core/events.js')>()), appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}), uploadPrivateFiles: vi.fn(async () => []) }));
vi.mock('../files/store.js', () => ({ recordFilePosts: vi.fn(async () => {}) }));
vi.mock('./charts-store.js', () => ({ saveReplyExtras: vi.fn(async () => {}) }));
const saved: any[] = [];
const dmed: any[] = [];
let threadTs: string | undefined = undefined;
vi.mock('./private-reply.js', async (orig) => ({
  ...(await orig<typeof import('./private-reply.js')>()),
  privateThreadTs: vi.fn(async () => threadTs),
  savePrivateReply: vi.fn(async (r: any) => (saved.push(r), 7)),
  sendFilesToDm: vi.fn(async (userId: string, files: any[]) => void dmed.push({ userId, files })),
}));

const { ReplyManager } = await import('./reply.js');
const { PRIVATE_SHARE_ACTION } = await import('./private-reply.js');

const target = () => ({
  threadId: 'C1:1.1',
  channelId: 'C1',
  threadTs: '1.1',
  turnId: 1,
  turnKind: 'user' as const,
  recipientUserId: 'U1',
  activeRuns: async () => 0,
  privateTo: 'U1',
});

const reset = () => {
  calls.length = 0;
  saved.length = 0;
  dmed.length = 0;
};

describe('private (`!p`) replies', () => {
  it('never stream: posted whole as an ephemeral to the author, with a "Send to thread" button', async () => {
    reset();
    const rm = new ReplyManager(target());
    rm.open('tc1');
    const json = JSON.stringify({ text: 'only for you, <!channel> stays quiet' });
    for (let i = 0; i < json.length; i += 5) rm.delta('tc1', json.slice(i, i + 5));
    await new Promise((r) => setTimeout(r, 300));
    const res = await rm.finish('tc1', 'only for you, <!channel> stays quiet');
    expect(res).toMatch(/^Replied privately/);
    expect(calls.map((c) => c.method)).toEqual(['chat.postEphemeral']);
    const post = calls[0]!.args;
    expect(post).toMatchObject({ channel: 'C1', user: 'U1' });
    expect(post.thread_ts).toBeUndefined(); // top-level question: at the channel root
    expect(JSON.stringify(post)).not.toMatch(/<!channel>/);
    const buttons = post.blocks.filter((b: any) => b.type === 'actions').flatMap((b: any) => b.elements);
    expect(buttons).toEqual([expect.objectContaining({ action_id: PRIVATE_SHARE_ACTION, value: '7' })]);
    expect(saved[0]).toMatchObject({ threadId: 'C1:1.1', userId: 'U1', turnId: 1 });
    expect(rm.anyVisible).toBe(true);
    expect(rm.lastDelivered).toBeNull(); // nothing for a plan card to attach to
  });

  it('goes into the thread when the question was asked in one', async () => {
    reset();
    threadTs = '1.1';
    await new ReplyManager(target()).finish('tc1', 'hi');
    threadTs = undefined;
    expect(calls[0]!.args.thread_ts).toBe('1.1');
  });

  it('sends files to the DM and leaves quick-reply buttons out', async () => {
    reset();
    const res = await new ReplyManager(target()).finish('tc1', 'here you go', [{ filename: 'a.md', fileId: 'file_1' }], ['yes', 'no']);
    expect(dmed).toEqual([{ userId: 'U1', files: [{ filename: 'a.md', fileId: 'file_1' }] }]);
    expect(res).toContain("Quick-reply buttons aren't available");
    expect(calls.map((c) => c.method)).toEqual(['chat.postEphemeral']);
    expect(JSON.stringify(calls[0]!.args.blocks)).toContain('in your DM');
    expect(saved[0].files).toEqual([{ filename: 'a.md', fileId: 'file_1' }]);
  });

  it('drops an empty reply', async () => {
    reset();
    const res = await new ReplyManager(target()).finish('tc1', '  ');
    expect(res).toMatch(/^Not posted/);
    expect(calls).toEqual([]);
  });
});
