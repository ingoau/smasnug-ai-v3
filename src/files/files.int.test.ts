/**
 * File store against the fake Slack + test Postgres/Redis: create → reply(files) upload, upload registration, lazy
 * fetch, read_file / ask_file, access denial, deletion, subagent listings and the img_N → file migration.
 *   INTEGRATION=1 pnpm vitest run src/files/files.int.test.ts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
vi.mock('../core/events.js', async (orig) => ({ ...(await orig<typeof import('../core/events.js')>()), appendEvent: vi.fn(async () => {}) }));

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('file store', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let toolsFor: typeof import('../core/tools.js').toolsFor;
  let S: typeof import('./store.js');
  let T: typeof import('./tools.js');
  let D: typeof import('./describe.js');
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  let sharp: typeof import('sharp').default;
  const removers: (() => void)[] = [];
  const CH = `CFILES${rand()}`;
  const DM = `DFILES${rand()}`;
  const threadOf = (ch: string) => `${ch}:1790000${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}.000100`;
  const ctxOf = (threadId: string, speakerId: string, extra: object = {}) => {
    const [channelId, threadTs] = threadId.split(':') as [string, string];
    return { threadId, channelId, threadTs, speakerId, turnId: Math.floor(Math.random() * 1e9), extras: {}, ...extra };
  };
  const exec = (role: 'front' | 'child', c: any, name: string, input: object) => (toolsFor(role, c)[name] as any).execute(input, { toolCallId: 'tc1', messages: [] });
  let slackIds = 0;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    ({ toolsFor } = await import('../core/tools.js'));
    await import('../tools/index.js');
    S = await import('./store.js');
    T = await import('./tools.js');
    D = await import('./describe.js');
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    sharp = (await import('sharp')).default;
    const { addFakeHandler } = await import('../core/slack-fake.js');
    // Unique Slack file ids per run (file_posts is keyed by them).
    removers.push(
      addFakeHandler((method) => (method === 'files.getUploadURLExternal' ? { ok: true, upload_url: 'https://fake.invalid/upload', file_id: `FUP${rand()}${++slackIds}` } : undefined)),
    );
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    removers.forEach((r) => r());
    await D.settleDescriptions();
    await sql`delete from files where channel_id in ${sql([CH, DM])}`;
    await sql`delete from messages where channel_id in ${sql([CH, DM])}`;
    await sql`delete from threads where channel_id in ${sql([CH, DM])}`;
    await redis.quit();
    await sql.end();
  });

  it('create_file → reply(files) uploads it to the thread (external upload flow), once per turn, and maps the Slack copy back', async () => {
    const threadId = threadOf(CH);
    const ctx = ctxOf(threadId, 'U_ALICE');
    const made = await exec('front', ctx, 'create_file', { name: 'index.html', content: '<!doctype html><h1>Club</h1>', description: 'Landing page for the club' });
    expect(made).toMatchObject({ name: 'index.html', mime: 'text/html', size: 28, description: 'Landing page for the club' });
    expect(made.file_id).toMatch(/^file_[a-z0-9]{10}$/);
    // Same turn, same content → the same file (retried side effect).
    expect((await exec('front', ctx, 'create_file', { name: 'index.html', content: '<!doctype html><h1>Club</h1>', description: 'x' })).file_id).toBe(made.file_id);

    const { prepareOutgoingFiles } = await import('../agent/files.js');
    const { ReplyManager } = await import('../agent/reply.js');
    const prepared = await prepareOutgoingFiles(ctx, [made.file_id, { filename: 'notes.md', content: '# Notes', description: 'Build notes' }, 'file_zzzzzzzzzz']);
    expect(prepared.files.map((f) => f.filename)).toEqual(['index.html', 'notes.md']);
    expect(prepared.errors).toHaveLength(1);
    expect(prepared.errors[0]).toMatch(/No file "file_zzzzzzzzzz" is available here/);

    const n = (await fakeCalls()).length;
    const target = { threadId, channelId: ctx.channelId, threadTs: ctx.threadTs, turnId: ctx.turnId, turnKind: 'user' as const, recipientUserId: 'U_ALICE', activeRuns: async () => 1 };
    expect(await new ReplyManager(target).finish('tc1', 'Here it is', prepared.files)).toMatch(/^Replied \(posted\)/);
    const calls = (await fakeCalls()).slice(n);
    const urls = calls.filter((c) => c.method === 'files.getUploadURLExternal');
    expect(urls.map((c) => c.args)).toEqual([
      { filename: 'index.html', length: 28 },
      { filename: 'notes.md', length: 7 },
    ]);
    const complete = calls.filter((c) => c.method === 'files.completeUploadExternal');
    expect(complete).toHaveLength(1);
    expect(complete[0]!.args).toMatchObject({ channel_id: ctx.channelId, thread_ts: ctx.threadTs });
    expect(complete[0]!.args.files.map((f: any) => f.title)).toEqual(['index.html', 'notes.md']);

    // The posted copy maps back to the same id, in a thread where it is now usable by anyone.
    const slackId = complete[0]!.args.files[0].id;
    const [post] = await sql<any[]>`select * from file_posts where slack_file_id = ${slackId}`;
    expect(post).toMatchObject({ fileId: made.file_id, threadId });
    const otherThread = threadOf(CH);
    await S.recordFilePosts([{ fileId: made.file_id, slackFileId: `FPOSTED${rand()}`, channelId: CH, threadId: otherThread }]);
    const [posted] = await sql<{ slackFileId: string }[]>`select slack_file_id from file_posts where thread_id = ${otherThread}`;
    const reg = await S.registerSlackFiles(otherThread, [{ ts: '1790000999.000100', userId: 'UBOT', botId: 'BBOT', username: 'Smasnug', text: '', files: [{ id: posted!.slackFileId, name: 'index.html' }] }]);
    expect(reg.get(posted!.slackFileId)).toMatchObject({ id: made.file_id, description: 'Landing page for the club' });
    expect(await S.resolveFile(made.file_id, { threadId: otherThread, speakerId: 'U_BOB' })).toMatchObject({ id: made.file_id });
  });

  it("access: the owner can use their file anywhere; others can't pull it out of its thread by id", async () => {
    const dmThread = threadOf(DM);
    const chThread = threadOf(CH);
    const f = await S.createFile({ threadId: dmThread, ownerId: 'U_ALICE', name: 'secret.txt', content: Buffer.from('private notes'), description: 'Private notes' });
    const { prepareOutgoingFiles } = await import('../agent/files.js');
    const bob = await prepareOutgoingFiles({ threadId: chThread, speakerId: 'U_BOB' }, [f.id]);
    expect(bob.files).toEqual([]);
    expect(bob.errors[0]).toMatch(/is available here/);
    expect(await exec('front', ctxOf(chThread, 'U_BOB'), 'read_file', { file_id: f.id })).toMatch(/No file .* is available here/);
    expect(await exec('child', ctxOf(chThread, 'U_BOB'), 'ask_file', { file_id: f.id, question: 'What does it say?' })).toMatch(/is available here/);
    const alice = await prepareOutgoingFiles({ threadId: chThread, speakerId: 'U_ALICE' }, [f.id]);
    expect(alice.files).toEqual([{ fileId: f.id, filename: 'secret.txt' }]);
    expect(await exec('front', ctxOf(chThread, 'U_ALICE'), 'read_file', { file_id: f.id })).toContain('private notes');
    // Too large: refused at creation.
    expect(await exec('child', ctxOf(chThread, 'U_ALICE', { runId: 1 }), 'create_file', { name: 'big.txt', content: 'x'.repeat(5 * 1024 * 1024 + 1), description: 'big' })).toMatch(/too large/);
  });

  it('uploads: registered with metadata only, fetched lazily once, paged by read_file, described once', async () => {
    const threadId = threadOf(CH);
    const log = Array.from({ length: 3000 }, (_, i) => `2026-10-07 12:00:${String(i % 60).padStart(2, '0')} worker ${i}: ok`).join('\n');
    const reg = await S.registerSlackFiles(threadId, [
      { ts: '1790000100.000100', userId: 'U_ALICE', botId: null, username: null, text: 'logs', files: [{ id: `FLOG${rand()}`, name: 'worker.log', mimetype: 'text/plain', urlPrivate: 'https://files.slack.com/files-pri/T/worker.log', size: log.length }] },
    ]);
    const ctxFile = [...reg.values()][0]!;
    let meta = (await S.fileStore.metadata(ctxFile.id))!;
    expect(meta).toMatchObject({ origin: 'upload', hasContent: false, ownerId: 'U_ALICE', size: log.length, messageTs: '1790000100.000100' });

    let downloads = 0;
    const bytes = await S.loadFileBytes(meta, { download: async () => (downloads++, Buffer.from(log)) });
    expect(bytes.toString()).toBe(log);
    meta = (await S.fileStore.metadata(ctxFile.id))!;
    expect(meta.hasContent).toBe(true);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    await S.loadFileBytes(meta, { download: async () => (downloads++, Buffer.from('')) });
    expect(downloads).toBe(1);
    expect((await S.fileStore.getRange(meta.id, 0, 10))!.toString()).toBe(log.slice(0, 10));

    // read_file pages the text (stored content: no download) and starts a description once.
    const described: string[] = [];
    const generate = vi.spyOn(D.describer, 'generate').mockImplementation(async (i) => (described.push(i.meta.id), 'Worker log: 3000 "ok" lines\nfrom 12:00'));
    const ctx = ctxOf(threadId, 'U_BOB');
    const p1: string = await exec('front', ctx, 'read_file', { file_id: meta.id });
    expect(p1).toMatch(new RegExp(`^${meta.id}: worker\\.log \\(text, \\d+ KB\\), uploaded by <@U_ALICE>`));
    const next = Number(/offset=(\d+)\]/.exec(p1)![1]);
    expect(p1).toContain(`[chars 0–${next} of ${log.length}; next: read_file file_id=${meta.id} offset=${next}]`);
    expect(p1).toContain('<untrusted_content');
    const p2: string = await exec('front', ctx, 'read_file', { file_id: meta.id, offset: next });
    expect(p2).toContain(`[chars ${next}–`);
    await D.settleDescriptions();
    expect(described).toEqual([meta.id]);
    const again = await S.registerSlackFiles(threadId, [{ ts: '1790000100.000100', userId: 'U_ALICE', botId: null, username: null, text: '', files: [{ id: meta.slackFileId!, name: 'worker.log' }] }]);
    expect(again.get(meta.slackFileId!)?.description).toBe("Worker log: 3000 'ok' lines from 12:00");
    generate.mockRestore();

    // Too large to open (non-image): refused before any download.
    const big = await S.registerSlackFiles(threadId, [
      { ts: '1790000101.000100', userId: 'U_ALICE', botId: null, username: null, text: '', files: [{ id: `FBIG${rand()}`, name: 'dump.csv', mimetype: 'text/csv', urlPrivate: 'https://files.slack.com/x', size: 9 * 1024 * 1024 }] },
    ]);
    expect(await exec('front', ctx, 'read_file', { file_id: [...big.values()][0]!.id })).toMatch(/too large to open \(9\.0 MB/);
    // PDFs etc.: metadata only, no download.
    const pdf = await S.registerSlackFiles(threadId, [
      { ts: '1790000102.000100', userId: 'U_ALICE', botId: null, username: null, text: '', files: [{ id: `FPDF${rand()}`, name: 'spec.pdf', mimetype: 'application/pdf', urlPrivate: 'https://files.slack.com/y', size: 1000 }] },
    ]);
    expect(await exec('front', ctx, 'read_file', { file_id: [...pdf.values()][0]!.id })).toMatch(/This pdf file can't be read as text or viewed here/);
  });

  it('images: read_file returns the image itself (resized, cached); ask_file sends it to a vision call; legacy img_N resolves', async () => {
    const threadId = threadOf(CH);
    const slackId = `FIMG${rand()}`;
    const reg = await S.registerSlackFiles(threadId, [{ ts: '1790000200.000100', userId: 'U_ALICE', botId: null, username: null, text: '', files: [{ id: slackId, name: 'shot.png', mimetype: 'image/png', urlPrivate: 'https://files.slack.com/z' }] }]);
    const id = reg.get(slackId)!.id;
    const meta = (await S.fileStore.metadata(id))!;
    const { loadImageForModel } = await import('./images.js');
    const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#cc3366' } }).png().toBuffer();
    const img = await loadImageForModel(meta, { download: async () => big });
    expect([img.width, img.height]).toEqual([1500, 500]);
    const heicMeta = { ...meta, id: 'file_heictest01', slackFileId: `FHEIC${rand()}`, mime: 'image/heic', name: 'IMG_1.HEIC', hasContent: false };
    const heic = await loadImageForModel(heicMeta, { download: async () => readFile(path.join(import.meta.dirname, '../tools/__fixtures__/sample.heic')) });
    expect([heic.mediaType, heic.width, heic.height]).toEqual(['image/jpeg', 320, 200]);

    const generate = vi.spyOn(D.describer, 'generate').mockResolvedValue('Pink test rectangle');
    const t = toolsFor('child', ctxOf(threadId, 'U_BOB')).read_file as any;
    const out = await t.execute({ file_id: id }, { toolCallId: 'x', messages: [] }); // cached: no download
    const model = await t.toModelOutput({ toolCallId: 'x', input: {}, output: out });
    expect(model.type).toBe('content');
    expect(model.value[0].text).toContain(`${id}: shot.png (image`);
    expect(model.value[1]).toMatchObject({ type: 'file', mediaType: 'image/png', data: { type: 'data' } });
    // The QueueUserImage fallback still works.
    const queued: any[] = [];
    const t2 = toolsFor('front', ctxOf(threadId, 'U_BOB', { extras: { queueUserImage: (i: any) => void queued.push(i) } })).read_file as any;
    expect(await t2.execute({ file_id: id }, { toolCallId: 'x', messages: [] })).toMatch(/Image loaded \(1500×500\)/);
    expect(queued[0]).toMatchObject({ id, mediaType: 'image/png' });

    const asked: any[] = [];
    const answer = vi.spyOn(T.fileAnswerer, 'answer').mockImplementation(async (o) => (asked.push(o.messages), 'A pink rectangle, no text.'));
    const res: string = await exec('child', ctxOf(threadId, 'U_BOB'), 'ask_file', { file_id: id, question: 'What is in it?' });
    expect(res).toContain('A pink rectangle, no text.');
    expect(res).toContain('<untrusted_content source="ask_file answer">');
    expect(asked[0][0].content[1]).toMatchObject({ type: 'file', mediaType: 'image/png' });
    expect(asked[0][0].content[0].text).toContain('Question: What is in it?');

    // Pre-file-store ids (migrated rows keep their img_N in their thread).
    await sql`update files set legacy_image_n = 7 where id = ${id}`;
    expect(await S.resolveFile('img_7', { threadId, speakerId: 'U_BOB' })).toMatchObject({ id });
    expect(await S.resolveFile('img_7', { threadId: threadOf(CH), speakerId: 'U_ALICE' })).toHaveProperty('error');

    // Per-turn cap on ask_file.
    const tools = toolsFor('child', ctxOf(threadId, 'U_BOB'));
    for (let i = 0; i < 12; i++) await (tools.ask_file as any).execute({ file_id: id, question: 'again?' }, { toolCallId: `a${i}`, messages: [] });
    expect(await (tools.ask_file as any).execute({ file_id: id, question: 'again?' }, { toolCallId: 'last', messages: [] })).toMatch(/already used 12 times/);
    answer.mockRestore();
    await D.settleDescriptions();
    generate.mockRestore();
  });

  it('ask_file on a text file sends the text (capped) to the answering model', async () => {
    const threadId = threadOf(CH);
    const f = await S.createFile({ threadId, ownerId: 'U_ALICE', name: 'config.yml', content: Buffer.from('port: 8080\nmode: prod\n'), description: 'Service config' });
    const asked: any[] = [];
    const answer = vi.spyOn(T.fileAnswerer, 'answer').mockImplementation(async (o) => (asked.push(o.messages), 'Port 8080.'));
    expect(await exec('front', ctxOf(threadId, 'U_BOB'), 'ask_file', { file_id: f.id, question: 'Which port?' })).toContain('Port 8080.');
    expect(asked[0][0].content).toContain('<file>\nport: 8080\nmode: prod\n\n</file>');
    expect(asked[0][0].content).toContain('File: config.yml (text');
    answer.mockRestore();
  });

  it('deleting or editing the Slack message removes its uploads', async () => {
    const { storeMessage, applyDelete, applyEdit } = await import('../pipeline/store.js');
    const threadId = threadOf(CH);
    const ts = `1790000300.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const a = `FDEL${rand()}`;
    const b = `FDEL${rand()}`;
    const msg = { ts, user: 'U_ALICE', text: 'two files', files: [{ id: a, name: 'a.txt', mimetype: 'text/plain' }, { id: b, name: 'b.txt', mimetype: 'text/plain' }] };
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${CH}, ${threadId.split(':')[1]!}) on conflict do nothing`;
    await storeMessage(CH, threadId, msg);
    await S.registerSlackFiles(threadId, [{ ts, userId: 'U_ALICE', botId: null, username: null, text: '', files: [{ id: a, name: 'a.txt' }, { id: b, name: 'b.txt' }] }]);
    const count = async () => (await sql<{ slackFileId: string }[]>`select slack_file_id from files where channel_id = ${CH} and message_ts = ${ts}`).map((r) => r.slackFileId).sort();
    expect(await count()).toEqual([a, b].sort());
    // One file deleted from the message (Slack sends the edit with a tombstone).
    await applyEdit(CH, { ...msg, files: [{ id: a, name: 'a.txt', mimetype: 'text/plain' }, { id: b, mode: 'tombstone' } as any] });
    expect(await count()).toEqual([a]);
    await applyDelete(CH, ts);
    expect(await count()).toEqual([]);
  });

  it('subagent-made files are listed per run (metadata only)', async () => {
    const threadId = threadOf(CH);
    const runId = 900_000_000 + Math.floor(Math.random() * 1e6);
    const ctx = ctxOf(threadId, 'U_ALICE', { runId, subagentId: 'sa_test01' });
    const made = await exec('child', ctx, 'create_file', { name: 'chart.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>', description: 'Signups per week chart' });
    expect(made.note).toMatch(/listed with your result/);
    await S.createFile({ threadId, ownerId: 'U_ALICE', name: 'bundle.tar', content: Buffer.from('x'), description: 'preview', createdRunId: runId, internal: true });
    const listed = (await S.filesCreatedByRuns([runId])).get(runId)!;
    expect(listed).toEqual([{ id: made.file_id, name: 'chart.svg', mime: 'image/svg+xml', size: 41, description: 'Signups per week chart' }]);
    const [row] = await sql<any[]>`select created_run_id, created_subagent_id, created_turn_id, owner_id from files where id = ${made.file_id}`;
    expect(row).toMatchObject({ createdSubagentId: 'sa_test01', createdTurnId: null, ownerId: 'U_ALICE' });
    expect(Number(row.createdRunId)).toBe(runId);
  });

  it('migration 230 moves thread_images (img_N) into files', async () => {
    const body = await readFile(path.join(import.meta.dirname, '../db/migrations/230_files.sql'), 'utf8');
    const block = body.slice(body.indexOf('-- BEGIN thread_images → files'), body.indexOf('-- END thread_images → files'));
    expect(block).toContain('do $$');
    const threadId = threadOf(CH);
    const rows = await sql
      .begin(async (tx) => {
        // A temp table shadows the (dropped) real one for this transaction only.
        await tx`create temp table thread_images (thread_id text not null, n int not null, file_id text not null, name text, mimetype text,
          url_private text, from_user text, message_ts text, primary key (thread_id, n), unique (thread_id, file_id)) on commit drop`;
        await tx`insert into thread_images values
          (${threadId}, 1, 'FMIG1', 'screenshot.png', 'image/png', 'https://files.slack.com/a', 'U_ALICE', '1790000400.000100'),
          (${threadId}, 2, 'FMIG2', null, null, null, null, '1790000401.000100')`;
        await tx.unsafe(block);
        const [left] = await tx<{ t: string | null }[]>`select to_regclass('pg_temp.thread_images')::text as t`;
        expect(left!.t).toBeNull();
        const got = await tx<any[]>`select id, origin, thread_id, channel_id, owner_id, slack_file_id, slack_url, message_ts, name, mime, legacy_image_n from files where thread_id = ${threadId} order by legacy_image_n`;
        throw Object.assign(new Error('rollback'), { got });
      })
      .catch((err) => {
        if (err.message !== 'rollback') throw err;
        return err.got as any[];
      });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ origin: 'upload', threadId, channelId: CH, ownerId: 'U_ALICE', slackFileId: 'FMIG1', slackUrl: 'https://files.slack.com/a', messageTs: '1790000400.000100', name: 'screenshot.png', mime: 'image/png', legacyImageN: 1 });
    expect(rows[1]).toMatchObject({ slackFileId: 'FMIG2', name: 'image', ownerId: null, legacyImageN: 2 });
    for (const r of rows) expect(r.id).toMatch(/^file_[a-z0-9]{10}$/);
    // The real migration ran: the old table and column are gone.
    const [t] = await sql<{ t: string | null }[]>`select to_regclass('public.thread_images')::text as t`;
    expect(t!.t).toBeNull();
    const cols = await sql`select 1 from information_schema.columns where table_name = 'threads' and column_name = 'next_image_n'`;
    expect(cols).toHaveLength(0);
  });
});
