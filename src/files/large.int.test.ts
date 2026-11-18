/**
 * Large files against the fake Slack + test Postgres/Redis: a staged file over the store's cap becomes a private Slack
 * upload (no content in Postgres), is idempotent, can't be opened, is copied when posted, and its Slack copy is swept
 * once the row is gone.
 *   INTEGRATION=1 pnpm vitest run src/files/large.int.test.ts
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

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('large files', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let L: typeof import('./large.js');
  let S: typeof import('./store.js');
  let A: typeof import('../agent/files.js');
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  const removers: (() => void)[] = [];
  const CH = `CLARGE${rand()}`;
  const threadId = `${CH}:1790000123.000100`;
  let n = 0;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    L = await import('./large.js');
    S = await import('./store.js');
    A = await import('../agent/files.js');
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    const { addFakeHandler } = await import('../core/slack-fake.js');
    removers.push(
      addFakeHandler((method, args) => {
        if (method === 'files.getUploadURLExternal') return { ok: true, upload_url: 'https://fake.invalid/upload', file_id: `FLG${rand()}${++n}` };
        if (method === 'files.completeUploadExternal') return { ok: true, files: (args.files as { id: string }[]).map((f) => ({ id: f.id })) };
        return undefined;
      }),
    );
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    removers.forEach((r) => r());
    await sql`delete from file_blobs where file_id in (select id from files where channel_id = ${CH})`;
    await sql`delete from files where channel_id = ${CH}`;
    await redis.quit();
    await sql.end();
  });

  async function stage(bytes: Buffer) {
    async function* gen() {
      yield new Uint8Array(bytes);
    }
    return L.stageStream(gen(), 1 << 20);
  }
  const input = (key: string) => ({ threadId, ownerId: 'U_ALICE', name: 'deck.pptx', description: 'Template deck', createdRunId: 7, idempotencyKey: key });

  it('over the store cap: a private Slack upload, idempotent, not openable, copied when posted, swept when gone', async () => {
    const bytes = Buffer.alloc(5000, 7);
    const staged = await stage(bytes);
    const key = `test-large:${rand()}`;
    const before = (await fakeCalls()).length;
    let meta: Awaited<ReturnType<typeof L.createFileFromStaged>>;
    try {
      meta = await L.createFileFromStaged(input(key), staged, { storeMax: 1000 });
      // Same key: the same file, no second upload.
      const again = await L.createFileFromStaged(input(key), staged, { storeMax: 1000 });
      expect(again.id).toBe(meta.id);
    } finally {
      await staged.cleanup();
    }
    expect(meta).toMatchObject({ origin: 'created', hasContent: false, size: 5000, name: 'deck.pptx', createdRunId: 7 });
    expect(meta.blobSlackFileId).toMatch(/^FLG/);
    const calls = (await fakeCalls()).slice(before);
    const urls = calls.filter((c) => c.method === 'files.getUploadURLExternal');
    expect(urls).toHaveLength(1);
    expect(urls[0]!.args).toEqual({ filename: 'deck.pptx', length: 5000 });
    const complete = calls.filter((c) => c.method === 'files.completeUploadExternal');
    expect(complete).toHaveLength(1);
    expect(complete[0]!.args.channel_id).toBeUndefined();
    const [blob] = await sql<{ fileId: string }[]>`select file_id from file_blobs where slack_file_id = ${meta.blobSlackFileId}`;
    expect(blob?.fileId).toBe(meta.id);
    // Listed with the run's result like any created file.
    expect((await S.filesCreatedByRuns([7])).get(7)?.some((f) => f.id === meta.id)).toBe(true);

    // Can't be opened.
    await expect(S.loadFileBytes((await S.fileStore.metadata(meta.id))!)).rejects.toThrow(/can only be posted/);

    // Posting copies it into the thread (fake: no bytes move) and records the post.
    const n0 = (await fakeCalls()).length;
    await A.uploadFiles({ channelId: CH, threadTs: '1790000123.000100', files: [{ fileId: meta.id, filename: 'deck.pptx' }], idempotencyKey: `test-large-post:${rand()}` });
    const post = (await fakeCalls()).slice(n0);
    expect(post.find((c) => c.method === 'files.getUploadURLExternal')?.args).toMatchObject({ filename: 'deck.pptx', length: 5000 });
    expect(post.find((c) => c.method === 'files.completeUploadExternal')?.args).toMatchObject({ channel_id: CH, thread_ts: '1790000123.000100' });
    const [posted] = await sql`select 1 from file_posts where file_id = ${meta.id}`;
    expect(posted).toBeTruthy();

    // Row deleted (retention) → the Slack copy is deleted by the sweep (after its grace hour).
    await sql`delete from files where id = ${meta.id}`;
    await sql`update file_blobs set created_at = now() - interval '2 hours' where slack_file_id = ${meta.blobSlackFileId}`;
    const n1 = (await fakeCalls()).length;
    expect(await L.sweepLargeFileBlobs()).toBeGreaterThanOrEqual(1);
    expect((await fakeCalls()).slice(n1).some((c) => c.method === 'files.delete' && c.args.file === meta.blobSlackFileId)).toBe(true);
    expect(await sql`select 1 from file_blobs where slack_file_id = ${meta.blobSlackFileId}`).toHaveLength(0);
  });

  it('within the store cap: an ordinary stored file', async () => {
    const staged = await stage(Buffer.from('small file'));
    try {
      const meta = await L.createFileFromStaged(input(`test-small:${rand()}`), staged, { storeMax: 1000 });
      expect(meta).toMatchObject({ hasContent: true, blobSlackFileId: null, size: 10 });
    } finally {
      await staged.cleanup();
    }
  });
});
