/**
 * Replies with code through ReplyManager against the fake Slack (SLACK_FAKE=1: real slackCall incl. idempotency on
 * the test Postgres, calls recorded in the test Redis; the fake enforces Slack's streaming mode rules).
 * Run: INTEGRATION=1 pnpm vitest run src/agent/reply-code.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    try {
      process.loadEnvFile('.env');
    } catch {}
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../core/events.js', () => ({ appendEvent: vi.fn(async () => {}) }));
vi.mock('./files.js', () => ({ uploadFiles: vi.fn(async () => {}) }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPLY = [
  'Sure, a minimal page:',
  '',
  '```html',
  '<!doctype html>',
  '<h1>Hello, world!</h1>',
  '<p>Some <code>code</code> and <img src="cat.png"></p>',
  '```',
  '',
  'And a script:',
  '~~~',
  'console.log(`<h2>${name}</h2>`);',
  '~~~',
  '',
  '| Tag | Use |',
  '|---|---|',
  '| `<b>` | bold |',
  '',
  'Wrap titles in `<h1>` once per page.',
].join('\n');

describe.skipIf(!INTEGRATION)('reply code delivery (fake Slack)', () => {
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  let ReplyManager: typeof import('./reply.js').ReplyManager;
  let streamArgsText: typeof import('./slack-markdown.js').streamArgsText;
  let turnId = Math.floor(Math.random() * 1e9);
  const channelId = `CCODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const target = (runs: number) => ({
    threadId: `${channelId}:1700000000.000100`,
    channelId,
    threadTs: '1700000000.000100',
    turnId: ++turnId,
    turnKind: 'user' as const,
    recipientUserId: 'U1',
    activeRuns: async () => runs,
  });
  const callsSince = async (n: number) => (await fakeCalls()).slice(n).filter((c) => c.args?.channel === channelId);

  beforeAll(async () => {
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    ({ ReplyManager } = await import('./reply.js'));
    ({ streamArgsText } = await import('./slack-markdown.js'));
  });
  afterAll(async () => {
    if (!INTEGRATION) return;
    const { redis } = await import('../core/redis.js');
    const { sql } = await import('../db/index.js');
    await redis.quit();
    await sql.end();
  });

  const pre = (code: string, language: string) => ({ type: 'rich_text_preformatted', language, elements: [{ type: 'text', text: code }] });
  const HTML = '<!doctype html>\n<h1>Hello, world!</h1>\n<p>Some <code>code</code> and <img src="cat.png"></p>';
  const JS = 'console.log(`<h2>${name}</h2>`);';

  it('posted reply: code blocks as rich_text preformatted, prose and table as markdown', async () => {
    const n = (await fakeCalls()).length;
    expect(await new ReplyManager(target(1)).finish('tc1', REPLY)).toMatch(/^Replied \(posted\)/);
    const [post] = (await callsSince(n)).filter((c) => c.method === 'chat.postMessage');
    expect(post!.args.text).toBe(REPLY);
    const blocks = post!.args.blocks;
    expect(blocks.map((b: any) => b.type)).toEqual(['markdown', 'rich_text', 'markdown', 'rich_text', 'markdown', 'rich_text']);
    expect(blocks[1].elements).toEqual([pre(HTML, 'html')]);
    expect(blocks[3].elements).toEqual([pre(JS, 'text')]);
    expect(blocks[4]).toEqual({ type: 'markdown', text: '| Tag | Use |\n|---|---|\n| `<b>` | bold |' });
    expect(blocks[5].elements[0].elements).toContainEqual({ type: 'text', text: '<h1>', style: { code: true } });
    // Nothing affected by Slack's HTML→markdown rewrite is left in a markdown block.
    for (const b of blocks.filter((b: any) => b.type === 'markdown')) expect(b.text).not.toMatch(/<\/?(h[1-6]|code|img)\b/i);
  });

  it('streamed reply: one chunks-mode stream, code as blocks chunks, final layout identical to the posted one', async () => {
    const n = (await fakeCalls()).length;
    const rm = new ReplyManager(target(0));
    const json = JSON.stringify({ text: REPLY });
    for (let i = 0; i < json.length; i += 11) {
      rm.delta('tc1', json.slice(i, i + 11));
      await sleep(8);
    }
    await sleep(300);
    expect(await rm.finish('tc1', REPLY)).toMatch(/^Replied \(streamed\)/);
    const calls = await callsSince(n);
    const methods = calls.map((c) => c.method);
    expect(methods[0]).toBe('chat.startStream');
    expect(methods).toContain('chat.appendStream');
    expect(methods).not.toContain('chat.postMessage');
    const stream = calls.filter((c) => /Stream$/.test(c.method));
    for (const c of stream) expect(c.args.markdown_text).toBeUndefined();
    const chunks = stream.flatMap((c) => c.args.chunks ?? []);
    const blockChunks = chunks.filter((c: any) => c.type === 'blocks').flatMap((c: any) => c.blocks);
    expect(blockChunks.map((b: any) => b.elements[0].type)).toEqual(['rich_text_preformatted', 'rich_text_preformatted', 'rich_text_section']);
    expect(blockChunks[0].elements).toEqual([pre(HTML, 'html')]);
    expect(blockChunks[1].elements).toEqual([pre(JS, 'text')]);
    const md = stream.map((c) => streamArgsText(c.args)).join('');
    expect(md).not.toMatch(/Hello, world|console\.log|<\/?(h[1-6]|code|img)\b/i);
    expect(md).toContain('| `<b>` | bold |');
    // Final layout = what a posted reply looks like.
    const upd = calls.filter((c) => c.method === 'chat.update').at(-1)!;
    const posted = (await import('./reply.js')).markdownMessage(REPLY);
    expect(upd.args.blocks).toEqual(posted.blocks);
    expect(methods.indexOf('chat.update')).toBeGreaterThan(methods.indexOf('chat.stopStream'));
  });

  it('a stream closed by an error note stays in chunks mode (no streaming_mode_mismatch)', async () => {
    const n = (await fakeCalls()).length;
    const rm = new ReplyManager(target(0));
    rm.delta('tc1', '{"text":"Partial answer that is long enough to open');
    await sleep(200);
    expect(await rm.abortOpenStreams('Something broke.')).toBe(true);
    const stop = (await callsSince(n)).find((c) => c.method === 'chat.stopStream')!;
    expect(stop.args.chunks).toEqual([{ type: 'markdown_text', text: '\n\nSomething broke.' }]);
  });
});
