import '../tools/test-env.js';
import { describe, expect, it, vi } from 'vitest';

const calls: { method: string; args: any }[] = [];
vi.mock('../core/slack.js', () => ({
  slackCall: vi.fn(async (method: string, args: any) => {
    calls.push({ method, args });
    return { ok: true, ts: '1700000000.000900', team_id: 'T1' };
  }),
  slackErrorCode: () => undefined,
}));
vi.mock('../core/events.js', () => ({ appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}) }));

const { ReplyManager } = await import('./reply.js');

const target = (turnKind: 'user' | 'synthesis' = 'user') => ({
  threadId: 'C1:1.1',
  channelId: 'C1',
  threadTs: '1.1',
  turnId: 1,
  turnKind,
  recipientUserId: 'U1',
  activeRuns: async () => 0,
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
