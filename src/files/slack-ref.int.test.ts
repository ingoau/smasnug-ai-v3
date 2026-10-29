/**
 * Slack file ids (`F…`) as file refs (slack-ref.ts): a stored file for it, else registered from Slack when it is
 * shared in this conversation or a verified public channel, on a message that carries it and isn't `##`.
 *   INTEGRATION=1 pnpm vitest run src/files/slack-ref.int.test.ts
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

describe.skipIf(!INTEGRATION)('Slack file ids', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let S: typeof import('./store.js');
  const removers: (() => void)[] = [];
  const r = rand();
  const CH = `CSR${r}`; // where the bot is asked
  const PUB = `CSRPUB${r}`; // a public channel elsewhere
  const PRIV = `CSRPRV${r}`; // a private channel elsewhere
  const thread = `${CH}:1790000000.000100`;
  const ctx = { threadId: thread, speakerId: 'U_ASKER' };
  const HERE = `FHERE${r}`;
  const PUBF = `FPUB${r}`;
  const PRIVF = `FPRIV${r}`;
  const HIDDEN = `FHID${r}`;
  const CANVAS = `FCNV${r}`;
  const file = (id: string, shares: object, extra: object = {}) => ({
    ok: true,
    file: { id, name: `${id}.mp4`, mimetype: 'video/mp4', filetype: 'mp4', size: 34_000_000, url_private: `https://files.slack.com/files-pri/T/${id}.mp4`, shares, ...extra },
  });
  const msg = (ts: string, fileId: string, text = 'here it is') => ({ ok: true, messages: [{ ts, user: 'U_SAM', text, files: [{ id: fileId, name: 'clip.mp4' }] }] });

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    S = await import('./store.js');
    const fake = await import('../core/slack-fake.js');
    removers.push(
      fake.addFakeHandler((method, args) => {
        if (method === 'conversations.info' && args.channel === PUB) return { ok: true, channel: { id: PUB, name: 'clips', is_channel: true, is_private: false } };
        if (method === 'conversations.info' && args.channel === CH) return { ok: true, channel: { id: CH, name: 'team', is_channel: true, is_private: true } };
        if (method === 'conversations.info' && args.channel === PRIV) return { ok: true, channel: { id: PRIV, name: 'secret', is_channel: true, is_private: true } };
        if (method === 'files.info') {
          if (args.file === HERE) return file(HERE, { public: { [CH]: [{ ts: '1790000001.000100' }] } });
          if (args.file === PUBF) return file(PUBF, { public: { [PUB]: [{ ts: '1790000002.000100' }] } });
          if (args.file === PRIVF) return file(PRIVF, { private: { [PRIV]: [{ ts: '1790000003.000100' }] } });
          if (args.file === HIDDEN) return file(HIDDEN, { public: { [CH]: [{ ts: '1790000004.000100' }] } });
          if (args.file === CANVAS) return file(CANVAS, { public: { [CH]: [{ ts: '1790000005.000100' }] } }, { filetype: 'quip', name: 'Plan' });
          throw fake.fakeSlackError('file_not_found');
        }
        if (method === 'conversations.history') {
          if (args.channel === CH && args.latest === '1790000001.000100') return msg('1790000001.000100', HERE);
          if (args.channel === PUB && args.latest === '1790000002.000100') return msg('1790000002.000100', PUBF);
          if (args.channel === PRIV) return msg('1790000003.000100', PRIVF);
          if (args.channel === CH && args.latest === '1790000004.000100') return msg('1790000004.000100', HIDDEN, '## not for the bot');
        }
        return undefined;
      }),
    );
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    removers.forEach((x) => x());
    await sql`delete from files where channel_id = ${CH}`;
    await redis.quit();
    await sql.end();
  });

  it('a file shared in this conversation is registered here, once', async () => {
    const f = await S.resolveFile(HERE, ctx);
    expect(f).toMatchObject({ origin: 'upload', threadId: thread, channelId: CH, slackFileId: HERE, sourceChannelId: null, ownerId: null, mime: 'video/mp4', messageTs: '1790000001.000100' });
    const again = await S.resolveFile(`<https://x.slack.com/files/U0SAM/${HERE}/clip.mp4|clip.mp4>`, ctx);
    expect('id' in again && again.id).toBe('id' in f && f.id);
    // Another conversation doesn't get it through this thread's row (this one is a private channel).
    expect(await S.resolveFile(HERE, { threadId: `CSROTHER${r}:1790000000.000100`, speakerId: 'U_ASKER' })).toHaveProperty('error');
  });

  it('a file in a verified public channel is registered with its source channel', async () => {
    const f = await S.resolveFile(PUBF, ctx);
    expect(f).toMatchObject({ slackFileId: PUBF, sourceChannelId: PUB, sourcePublic: true, threadId: thread });
  });

  it('refuses private channels elsewhere, `##` messages, unknown ids; points canvases to read_canvas', async () => {
    expect((await S.resolveFile(PRIVF, ctx)) as any).toEqual({ error: expect.stringMatching(/only open Slack files shared in this conversation or in a public channel/) });
    expect((await S.resolveFile(HIDDEN, ctx)) as any).toHaveProperty('error');
    expect((await S.resolveFile(`FNOPE${r}`, ctx)) as any).toHaveProperty('error');
    expect(((await S.resolveFile(CANVAS, ctx)) as any).error).toMatch(/read_canvas/);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from files where slack_file_id in ${sql([PRIVF, HIDDEN, CANVAS])}`;
    expect(row!.n).toBe(0);
  });
});
