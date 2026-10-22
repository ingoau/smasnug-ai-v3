/**
 * Files seen outside the bot's own conversation (design doc, "Files"): slack_search results and read_public_thread
 * give their files ids in the asking thread (with the source channel), under the usual access rule; a source message
 * deletion or a file deleted in Slack (files.info) removes them; save_url stores a downloaded file.
 *   INTEGRATION=1 pnpm vitest run src/files/external-files.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
const fetchOverride = vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    try {
      process.loadEnvFile('.env');
    } catch {}
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
  return { fn: null as null | ((url: string) => Promise<any>) };
});
vi.mock('../core/events.js', async (orig) => ({ ...(await orig<typeof import('../core/events.js')>()), appendEvent: vi.fn(async () => {}) }));
// save_url downloads through safeFetch; tests answer from here instead of the network.
vi.mock('../tools/safe-fetch.js', async (orig) => {
  const real = await orig<typeof import('../tools/safe-fetch.js')>();
  return { ...real, safeFetch: (url: string, opts: any) => (fetchOverride.fn ? fetchOverride.fn(url) : real.safeFetch(url, opts)) };
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('files from elsewhere', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let toolsFor: typeof import('../core/tools.js').toolsFor;
  let S: typeof import('./store.js');
  let fakeSlackError: typeof import('../core/slack-fake.js').fakeSlackError;
  const removers: (() => void)[] = [];
  const r = rand();
  const CH = `CXF${r}`; // where the bot is asked
  const OTHER = `CXFO${r}`; // another conversation
  const PUB = `CXFPUB${r}`; // a public channel elsewhere
  const threadA = `${CH}:1790000000.000100`;
  const threadB = `${OTHER}:1790000000.000200`;
  const gone = new Set<string>();
  const ctxOf = (threadId: string, speakerId: string) => {
    const [channelId, threadTs] = threadId.split(':') as [string, string];
    return { threadId, channelId, threadTs, speakerId, turnId: Math.floor(Math.random() * 1e9), extras: {} };
  };
  const exec = (c: any, name: string, input: object) => (toolsFor('front', c)[name] as any).execute(input, { toolCallId: 'tc1', messages: [] });
  const fileIdsIn = (s: string) => [...s.matchAll(/\[file (file_[a-z0-9]{10}):/g)].map((m) => m[1]!);
  const SHOT = `FSHOT${r}`;
  const FWD = `FFWD${r}`;
  const LOGO = `FLOGO${r}`;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    ({ toolsFor } = await import('../core/tools.js'));
    await import('../tools/index.js');
    S = await import('./store.js');
    const fake = await import('../core/slack-fake.js');
    fakeSlackError = fake.fakeSlackError;
    removers.push(
      fake.addFakeHandler((method, args) => {
        if (method === 'conversations.info' && args.channel === PUB) return { ok: true, channel: { id: PUB, name: 'design', is_channel: true, is_private: false } };
        if (method === 'search.messages' && String(args.query).startsWith(`xf${r}`)) {
          return {
            ok: true,
            messages: {
              matches: [
                {
                  channel: { id: PUB, name: 'design' },
                  user: 'U_SAM',
                  ts: '1790000001.000100',
                  text: 'new logo',
                  permalink: `https://x.slack.com/archives/${PUB}/p1790000001000100`,
                  files: [{ id: LOGO, name: 'logo.png', mimetype: 'image/png', url_private: 'https://files.slack.com/files-pri/T/logo.png', size: 1234 }],
                },
              ],
            },
          };
        }
        if (method === 'conversations.replies' && args.channel === PUB) {
          return {
            ok: true,
            messages: [
              { ts: '1790000002.000100', user: 'U_SAM', text: 'screenshot of the bug', files: [{ id: SHOT, name: 'bug.png', mimetype: 'image/png', url_private: 'https://files.slack.com/files-pri/T/bug.png' }] },
              {
                ts: '1790000002.000200',
                thread_ts: '1790000002.000100',
                user: 'U_ALEX',
                text: '',
                attachments: [{ is_share: true, text: 'forwarded spec', author_name: 'Kim', files: [{ id: FWD, name: 'spec.pdf', mimetype: 'application/pdf' }] }],
              },
              { ts: '1790000002.000300', thread_ts: '1790000002.000100', user: 'U_ALEX', text: '## private note', files: [{ id: `FHIDDEN${r}`, name: 'secret.png' }] },
            ],
          };
        }
        if (method === 'files.info' && gone.has(String(args.file))) throw fakeSlackError('file_not_found');
        return undefined;
      }),
    );
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    removers.forEach((x) => x());
    await sql`delete from files where channel_id in ${sql([CH, OTHER])}`;
    await redis.quit();
    await sql.end();
  });

  it('slack_search: files on public results get ids in the asking thread, with their source channel', async () => {
    const out: string = await exec(ctxOf(threadA, 'U_ASKER'), 'slack_search', { query: `xf${r} logo` });
    const [id] = fileIdsIn(out);
    expect(id).toBeTruthy();
    expect(out).toContain(`[file ${id}: logo.png, image, from`);
    const meta = (await S.fileStore.metadata(id!))!;
    expect(meta).toMatchObject({ origin: 'upload', threadId: threadA, channelId: CH, sourceChannelId: PUB, sourcePublic: true, ownerId: 'U_SAM', slackFileId: LOGO });
    // Same search again: the same id (idempotent per thread + Slack file).
    expect(fileIdsIn(await exec(ctxOf(threadA, 'U_ASKER'), 'slack_search', { query: `xf${r} logo` }))).toEqual([id]);

    // Usable in the asking thread (any speaker), not from another conversation, except by its owner.
    expect('error' in (await S.resolveFile(id!, { threadId: threadA, speakerId: 'U_OTHER' }))).toBe(false);
    expect(await S.resolveFile(id!, { threadId: threadB, speakerId: 'U_OTHER' })).toHaveProperty('error');
    expect('error' in (await S.resolveFile(id!, { threadId: threadB, speakerId: 'U_SAM' }))).toBe(false);
  });

  it('read_public_thread: files (incl. forwarded ones) get ids; `##` messages stay invisible', async () => {
    const out: string = await exec(ctxOf(threadA, 'U_ASKER'), 'read_public_thread', { channel: PUB, thread_ts: '1790000002.000100' });
    expect(out).not.toContain('secret.png');
    expect(out).not.toContain('private note');
    const ids = fileIdsIn(out);
    expect(ids).toHaveLength(2);
    const metas = await Promise.all(ids.map(async (id) => (await S.fileStore.metadata(id))!));
    expect(metas.map((m) => m.slackFileId).sort()).toEqual([FWD, SHOT].sort());
    expect(metas.every((m) => m.sourceChannelId === PUB && m.sourcePublic && m.threadId === threadA)).toBe(true);
    // A forwarded file isn't the forwarder's: no owner (the owner rule would let them use it anywhere).
    expect(metas.find((m) => m.slackFileId === FWD)!.ownerId).toBeNull();
    expect(metas.find((m) => m.slackFileId === SHOT)!.ownerId).toBe('U_SAM');

    // Content is fetched on first use, like an upload.
    const shot = metas.find((m) => m.slackFileId === SHOT)!;
    const bytes = await S.loadFileBytes(shot, { download: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) });
    expect(bytes.byteLength).toBe(10);
    expect((await S.fileStore.metadata(shot.id))!.hasContent).toBe(true);

    // Posting it here resolves (reply(files) path).
    const { prepareOutgoingFiles } = await import('../agent/files.js');
    const prepared = await prepareOutgoingFiles({ threadId: threadA, speakerId: 'U_ASKER' }, [shot.id]);
    expect(prepared).toEqual({ files: [{ fileId: shot.id, filename: 'bug.png' }], errors: [] });
  });

  it('caps new registrations per tool result', async () => {
    const msgs = Array.from({ length: S.MAX_EXTERNAL_FILES + 5 }, (_, i) => ({
      ts: `1790000010.${String(i).padStart(6, '0')}`,
      userId: 'U_SAM',
      botId: null,
      username: null,
      text: '',
      files: [{ id: `FCAP${r}${i}`, name: `f${i}.txt` }],
    }));
    const reg = await S.registerExternalFiles(threadA, msgs, { sourceChannelId: PUB, sourcePublic: true });
    expect(reg.size).toBe(S.MAX_EXTERNAL_FILES);
    expect(reg.has(`FCAP${r}0`)).toBe(true);
    expect(reg.has(`FCAP${r}${S.MAX_EXTERNAL_FILES}`)).toBe(false);
  });

  it('search: one cap per result across channels, matches before nearby messages', async () => {
    const files = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${r}${i}`, name: `${prefix}${i}.txt` }));
    const matches = [
      { channel: { id: PUB, name: 'design' }, user: 'U_SAM', ts: '1790000030.000100', text: 'a', files: files('FSA', 20), next: { ts: '1790000030.000200', user: 'U_SAM', text: 'n', files: files('FSN', 5) } },
      { channel: { id: `${PUB}2`, name: 'other' }, user: 'U_SAM', ts: '1790000031.000100', text: 'b', files: files('FSB', 20) },
    ];
    const { registerSearchFiles } = await import('../tools/slack-search.js');
    const reg = await registerSearchFiles(threadA, matches);
    expect(reg.size).toBe(S.MAX_EXTERNAL_FILES);
    expect(reg.has(`FSB${r}9`)).toBe(true); // second match's files before the first match's nearby message
    expect(reg.has(`FSN${r}0`)).toBe(false);
    const b0 = (await S.fileStore.metadata(reg.get(`FSB${r}0`)!.id))!;
    expect(b0.sourceChannelId).toBe(`${PUB}2`);
  });

  it("the bot's own post seen from elsewhere maps back only when usable here; else it gets its own row", async () => {
    const made = await S.createFile({ threadId: threadB, ownerId: 'U_OWNER', name: 'secret-plan.md', content: Buffer.from('# plan'), description: 'written in a DM' });
    const slackId = `FPOST${r}`;
    await S.recordFilePosts([{ fileId: made.id, slackFileId: slackId, channelId: OTHER, threadId: threadB }]);
    const msg = { ts: '1790000040.000100', userId: 'UBOT', botId: 'BBOT', username: null, text: '', files: [{ id: slackId, name: 'secret-plan.md', urlPrivate: 'https://files.slack.com/p' }] };
    const reg = await S.registerExternalFiles(threadA, [msg], { sourceChannelId: PUB, sourcePublic: true });
    const cf = reg.get(slackId)!;
    expect(cf.id).not.toBe(made.id);
    expect(cf.description).toBeNull();
    // In the thread it was posted to, it still maps back.
    expect((await S.registerSlackFiles(threadB, [msg])).get(slackId)!.id).toBe(made.id);
  });

  it('deleting the source message removes the copies; a file deleted in Slack stops resolving', async () => {
    const ts = '1790000020.000100';
    const del = `FDEL${r}`;
    const reg = await S.registerExternalFiles(threadA, [{ ts, userId: 'U_SAM', botId: null, username: null, text: '', files: [{ id: del, name: 'd.txt' }] }], {
      sourceChannelId: PUB,
      sourcePublic: true,
    });
    const id = reg.get(del)!.id;
    // A deletion event in the thread's own channel with the same ts doesn't touch it.
    expect(await S.removeMessageFiles(CH, ts)).toBe(0);
    expect(await S.removeMessageFiles(PUB, ts)).toBe(1);
    expect(await S.fileStore.metadata(id)).toBeNull();

    const gid = `FGONE${r}`;
    const reg2 = await S.registerExternalFiles(threadA, [{ ts: '1790000021.000100', userId: 'U_SAM', botId: null, username: null, text: '', files: [{ id: gid, name: 'g.png' }] }], {
      sourceChannelId: PUB,
      sourcePublic: true,
    });
    const fid = reg2.get(gid)!.id;
    // The same Slack file in one of the bot's own conversations (no source): files.info's answer doesn't remove it.
    const own = (await S.registerSlackFiles(threadB, [{ ts: '1790000021.000200', userId: 'U_SAM', botId: null, username: null, text: '', files: [{ id: gid, name: 'g.png' }] }])).get(gid)!.id;
    gone.add(gid);
    const res = await S.resolveFile(fid, { threadId: threadA, speakerId: 'U_ASKER' });
    expect(res).toEqual({ error: expect.stringContaining('was deleted in Slack') });
    expect(await S.fileStore.metadata(fid)).toBeNull();
    expect(await S.fileStore.metadata(own)).not.toBeNull();
  });

  it('save_url stores a downloaded file (name from the URL, type sniffed), idempotent per turn; refuses Slack URLs', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const seen: string[] = [];
    fetchOverride.fn = async (url) => (seen.push(url), { status: 200, url, contentType: 'application/octet-stream', headers: {}, body: png, truncated: false });
    try {
      const ctx = ctxOf(threadA, 'U_ASKER');
      const url = 'https://raw.githubusercontent.com/hackclub/x/main/logo';
      const out = await exec(ctx, 'save_url', { url, description: 'Hack Club logo' });
      expect(out).toMatchObject({ name: 'logo.png', mime: 'image/png', kind: 'image', size: png.byteLength });
      const meta = (await S.fileStore.metadata(out.file_id))!;
      expect(meta).toMatchObject({ origin: 'created', threadId: threadA, ownerId: 'U_ASKER', description: 'Hack Club logo' });
      expect((await exec(ctx, 'save_url', { url, description: 'again' })).file_id).toBe(out.file_id);

      // An HTML page instead of the file: refused (never stored under an image's name), unless an .html file is asked for.
      fetchOverride.fn = async (u) => ({ status: 200, url: u, contentType: 'text/html; charset=utf-8', headers: {}, body: Buffer.from('<!doctype html><html></html>'), truncated: false });
      expect(await exec(ctx, 'save_url', { url: 'https://github.com/hackclub/x/blob/main/logo.png', description: 'logo' })).toMatch(/HTML page, not a file.*direct URL/);
      expect(await exec(ctx, 'save_url', { url: 'https://github.com/hackclub/x/blob/main/logo.png', name: 'logo.png', description: 'logo' })).toMatch(/HTML page/);
      expect(await exec(ctx, 'save_url', { url: 'https://hackclub.com/brand', description: 'brand' })).toMatch(/HTML page/); // no extension: not "brand.html"
      expect(await exec(ctx, 'save_url', { url: 'https://example.com/', description: 'home' })).toMatch(/HTML page/);
      const page = await exec(ctx, 'save_url', { url: 'https://example.com/', name: 'page.html', description: 'the page' });
      expect(page).toMatchObject({ name: 'page.html', kind: 'html' });

      fetchOverride.fn = async (u) => ({ status: 200, url: u, contentType: 'image/png', headers: {}, body: png, truncated: true });
      expect(await exec(ctx, 'save_url', { url: 'https://example.com/huge.png', description: 'x' })).toMatch(/larger than/);
      fetchOverride.fn = async (u) => ({ status: 404, url: u, contentType: 'text/html', headers: {}, body: Buffer.from(''), truncated: false });
      expect(await exec(ctx, 'save_url', { url: 'https://example.com/missing.png', description: 'x' })).toMatch(/HTTP 404/);

      const before = seen.length;
      expect(await exec(ctx, 'save_url', { url: 'https://files.slack.com/files-pri/T/x.png', description: 'x' })).toMatch(/can't download Slack URLs/);
      expect(seen.length).toBe(before);
    } finally {
      fetchOverride.fn = null;
    }
  });
});
