/**
 * Canvas tools against the fake Slack + test Postgres/Redis (TEST_DATABASE_URL / TEST_REDIS_URL):
 *   INTEGRATION=1 pnpm vitest run src/tools/canvases.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('canvas tools', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let toolsFor: typeof import('../core/tools.js').toolsFor;
  let fakeSlackError: typeof import('../core/slack-fake.js').fakeSlackError;
  let C: typeof import('./canvases.js');
  const removers: (() => void)[] = [];
  const threadIds: string[] = [];

  // Fake Slack state: canvases' markdown, files.info objects, conversation kinds; every canvas-related call.
  const content = new Map<string, string>();
  const files = new Map<string, any>();
  const convs = new Map<string, { is_private?: boolean; is_im?: boolean; is_mpim?: boolean; members?: string[]; infoFails?: boolean; grantFails?: boolean }>();
  let calls: { method: string; args: any }[] = [];
  const callsOf = (m: string) => calls.filter((c) => c.method === m);

  const PUB = `CPUB${rand()}`;
  const PRIV = `CPRIV${rand()}`;
  const OTHERPUB = `CPUB2${rand()}`;
  const DM = `D${rand()}`;
  const MPIM = `GMP${rand()}`;
  const MPIM_NOINFO = `GMPX${rand()}`; // conversations.info fails for it
  const NOGRANT = `CNOGRANT${rand()}`; // the channel grant fails for it

  async function thread(channelId: string) {
    const threadTs = `1790000${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const threadId = `${channelId}:${threadTs}`;
    threadIds.push(threadId);
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channelId}, ${threadTs}) on conflict do nothing`;
    return { threadId, channelId, threadTs };
  }
  const ctx = async (channelId: string, speakerId = 'USPEAK', turnId = Math.floor(Math.random() * 1e9)) => ({ ...(await thread(channelId)), speakerId, turnId, extras: {} });
  const exec = (role: 'front' | 'child', c: any, name: string, input: object, toolCallId = 'tc1') =>
    (toolsFor(role, c)[name] as any).execute(input, { toolCallId, messages: [] }) as Promise<string>;
  const linkOf = (out: string) => /(https:\/\/\S+\/docs\/\S+\/(F[A-Z0-9]+))/.exec(out);

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    ({ toolsFor } = await import('../core/tools.js'));
    const fake = await import('../core/slack-fake.js');
    fakeSlackError = fake.fakeSlackError;
    C = await import('./canvases.js');
    await import('./register.js');
    convs.set(PUB, { is_private: false });
    convs.set(OTHERPUB, { is_private: false });
    convs.set(PRIV, { is_private: true });
    convs.set(MPIM, { is_private: true, is_mpim: true, members: ['USPEAK', 'UFRIEND', 'UBOT'] });
    convs.set(MPIM_NOINFO, { is_private: true, is_mpim: true, members: ['USPEAK', 'UPAL', 'UBOT'], infoFails: true });
    convs.set(NOGRANT, { is_private: false, grantFails: true });
    removers.push(
      fake.addFakeHandler((method, args) => {
        if (!method.startsWith('canvases.') && method !== 'files.info' && method !== 'conversations.info' && method !== 'conversations.members') return undefined;
        calls.push({ method, args });
        switch (method) {
          case 'canvases.create': {
            const id = `F${rand()}${rand()}`;
            content.set(id, String((args.document_content as any)?.markdown ?? ''));
            files.set(id, { id, title: args.title, permalink: `https://fake.slack.com/docs/TFAKE/${id}` });
            return { ok: true, canvas_id: id };
          }
          case 'canvases.getContent': {
            const c = content.get(String(args.canvas_id));
            if (c === undefined) throw fakeSlackError('canvas_not_found');
            return { ok: true, content: c };
          }
          case 'canvases.edit': {
            const id = String(args.canvas_id);
            if (!content.has(id)) throw fakeSlackError('canvas_not_found');
            const ch = (args.changes as any[])[0];
            if (ch.operation === 'insert_at_end') content.set(id, content.get(id) + '\n' + ch.document_content.markdown);
            if (ch.operation === 'replace') content.set(id, ch.document_content.markdown);
            return { ok: true };
          }
          case 'files.info': {
            const f = files.get(String(args.file));
            if (!f) throw fakeSlackError('file_not_found');
            return { ok: true, file: f };
          }
          case 'canvases.access.set': {
            // Channel ids are invalid for group DMs (docs.slack.dev/reference/methods/canvases.access.set).
            const ids = (args.channel_ids as string[] | undefined) ?? [];
            if (ids.some((id) => convs.get(id)?.is_mpim || convs.get(id)?.grantFails)) throw fakeSlackError('channel_not_found');
            return { ok: true };
          }
          case 'conversations.info': {
            const c = convs.get(String(args.channel));
            if (!c) return undefined;
            if (c.infoFails) throw fakeSlackError('internal_error');
            return { ok: true, channel: { id: args.channel, name: 'x', is_private: !!c.is_private, is_im: !!c.is_im, is_mpim: !!c.is_mpim } };
          }
          case 'conversations.members':
            return { ok: true, members: convs.get(String(args.channel))?.members ?? [], response_metadata: { next_cursor: '' } };
          default:
            return { ok: true };
        }
      }),
    );
  });

  beforeEach(() => {
    calls = [];
  });

  afterAll(async () => {
    removers.forEach((r) => r());
    if (!sql) return;
    for (const id of threadIds) await sql`delete from threads where id = ${id}`;
    await sql`delete from bot_canvases where thread_id = any(${threadIds})`;
    await sql.end();
    redis.disconnect();
  });

  it('roles: read for both, create/edit front only', () => {
    const c = { threadId: 'x:1', channelId: 'x', threadTs: '1', speakerId: 'U', extras: {} };
    expect(Object.keys(toolsFor('child', c))).toContain('read_canvas');
    expect(Object.keys(toolsFor('child', c))).not.toContain('create_canvas');
    expect(Object.keys(toolsFor('child', c))).not.toContain('edit_canvas');
    expect(Object.keys(toolsFor('front', c))).toEqual(expect.arrayContaining(['read_canvas', 'create_canvas', 'edit_canvas']));
  });

  it('create in a public channel: records, grants access, converts markdown, idempotent per turn', async () => {
    const c = await ctx(PUB);
    const input = { title: 'Plan <!channel>', content: 'Hi <@U123> <!here>, see <#C456|ship>' };
    const out = await exec('front', c, 'create_canvas', input);
    const m = linkOf(out);
    expect(m).toBeTruthy();
    const id = m![2]!;
    const create = callsOf('canvases.create');
    expect(create).toHaveLength(1);
    expect(create[0]!.args.title).not.toContain('<!channel>');
    expect(create[0]!.args.document_content.markdown).toBe('Hi ![](@U123) @​here, see ![](#C456)');
    const access = callsOf('canvases.access.set');
    expect(access.map((a) => [a.args.access_level, a.args.channel_ids ?? a.args.user_ids])).toEqual([
      ['read', [PUB]],
      ['write', ['USPEAK']],
    ]);
    const [row] = await sql`select * from bot_canvases where canvas_id = ${id}`;
    expect(row).toMatchObject({ channelId: PUB, threadId: c.threadId, creatorId: 'USPEAK', turnId: String(c.turnId) });

    calls = [];
    const again = await exec('front', c, 'create_canvas', input, 'tc2');
    expect(again).toContain(id);
    expect(callsOf('canvases.create')).toHaveLength(0);
  });

  it('create in a DM grants the speaker only; in a group DM the members by user id', async () => {
    await exec('front', await ctx(DM, 'UDM'), 'create_canvas', { title: 'Notes', content: 'x' });
    expect(callsOf('canvases.access.set').map((a) => [a.args.channel_ids, a.args.user_ids])).toEqual([[undefined, ['UDM']]]);
    calls = [];
    await exec('front', await ctx(MPIM), 'create_canvas', { title: 'Notes', content: 'y' });
    expect(callsOf('canvases.access.set').map((a) => [a.args.access_level, a.args.channel_ids, a.args.user_ids])).toEqual([
      ['read', undefined, ['UFRIEND']],
      ['write', undefined, ['USPEAK']],
    ]);
  });

  it("access: a failed conversations.info doesn't misclassify a group DM; a failed conversation grant is reported", async () => {
    const out = await exec('front', await ctx(MPIM_NOINFO), 'create_canvas', { title: 'Notes', content: 'z' });
    expect(callsOf('canvases.access.set').map((a) => [a.args.access_level, a.args.channel_ids, a.args.user_ids])).toEqual([
      ['read', [MPIM_NOINFO], undefined], // tried as a channel, refused
      ['read', undefined, ['UPAL']], // then by member ids
      ['write', undefined, ['USPEAK']],
    ]);
    expect(out).not.toMatch(/request access/);

    calls = [];
    const failed = await exec('front', await ctx(NOGRANT), 'create_canvas', { title: 'Notes', content: 'w' });
    expect(callsOf('canvases.access.set').map((a) => a.args.access_level)).toEqual(['read', 'write']);
    // The speaker's grant worked, but others in the channel may not be able to open it: the agent is told.
    expect(failed).toMatch(/Canvas created/);
    expect(failed).toMatch(/others here may have to request access/);
  });

  it('edit: allowed on own canvas (append, replace_section, rename), idempotent', async () => {
    const c = await ctx(PUB);
    const id = linkOf(await exec('front', c, 'create_canvas', { title: 'Trip', content: '## Budget\n100\n## Venue\nhall' }))![2]!;
    calls = [];
    const out = await exec('front', c, 'edit_canvas', { canvas: id, action: 'append', content: '## Notes\nbring <@U1>' });
    expect(out).toMatch(/Canvas updated/);
    expect(callsOf('canvases.edit')[0]!.args.changes).toEqual([{ operation: 'insert_at_end', document_content: { type: 'markdown', markdown: '## Notes\nbring ![](@U1)' } }]);
    await exec('front', c, 'edit_canvas', { canvas: id, action: 'append', content: '## Notes\nbring <@U1>' }, 'tc9');
    expect(callsOf('canvases.edit')).toHaveLength(1);

    await exec('front', c, 'edit_canvas', { canvas: `https://fake.slack.com/docs/TFAKE/${id}`, action: 'replace_section', heading: 'budget', content: '250' });
    expect(content.get(id)).toBe('## Budget\n\n250\n\n## Venue\nhall\n## Notes\nbring ![](@U1)');
    expect(await exec('front', c, 'edit_canvas', { canvas: id, action: 'replace_section', heading: 'nope', content: 'x' })).toMatch(/No heading matching/);
    // replace_section rewrites the whole canvas: group pings anywhere in it are neutralised, not just in the new part.
    content.set(id, `${content.get(id)}\n## Ping\nhey ![](!here) and ![](@S123ABC) <!channel>`);
    await exec('front', c, 'edit_canvas', { canvas: id, action: 'replace_section', heading: 'Venue', content: 'park <@U2>' });
    expect(content.get(id)).toBe('## Budget\n\n250\n\n## Venue\n\npark ![](@U2)\n\n## Notes\nbring ![](@U1)\n## Ping\nhey @\u200bhere and @\u200bgroup @\u200bchannel');

    await exec('front', c, 'edit_canvas', { canvas: id, action: 'rename', title: 'Trip v2' });
    expect(callsOf('canvases.edit').at(-1)!.args.changes[0]).toEqual({ operation: 'rename', title_content: { type: 'markdown', markdown: 'Trip v2' } });
    expect((await sql`select title from bot_canvases where canvas_id = ${id}`)[0]!.title).toBe('Trip v2');
  });

  it("edit: refused for canvases the bot did not create, and for other people's canvases", async () => {
    const foreign = `F${rand()}${rand()}`;
    content.set(foreign, '# theirs');
    files.set(foreign, { id: foreign, channels: [PUB] });
    const out = await exec('front', await ctx(PUB), 'edit_canvas', { canvas: foreign, action: 'replace_all', content: 'pwned' });
    expect(out).toMatch(/only edit canvases I created/);

    const id = linkOf(await exec('front', await ctx(PUB, 'UOWNER'), 'create_canvas', { title: 'Mine', content: 'a' }))![2]!;
    calls = [];
    const elsewhere = await exec('front', await ctx(OTHERPUB, 'USTRANGER'), 'edit_canvas', { canvas: id, action: 'append', content: 'b' });
    expect(elsewhere).toMatch(/belongs to <@UOWNER>/);
    // Someone else in the same channel can't have it rewritten either.
    const sameChannel = await exec('front', await ctx(PUB, 'USTRANGER'), 'edit_canvas', { canvas: id, action: 'replace_all', content: 'pwned' });
    expect(sameChannel).toMatch(/belongs to <@UOWNER>/);
    expect(callsOf('canvases.edit')).toHaveLength(0);
    // The creator can edit it from anywhere.
    expect(await exec('front', await ctx(OTHERPUB, 'UOWNER'), 'edit_canvas', { canvas: id, action: 'append', content: 'c' })).toMatch(/Canvas updated/);
  });

  it("from_subagent: publishes a thread subagent's full stored result server-side (pings neutralised, capped)", async () => {
    const c = await ctx(PUB);
    const sa = `sa_cv${rand().toLowerCase()}`;
    const longDoc = `## Report <!channel>\n${Array.from({ length: 3000 }, (_, i) => `- finding ${i} <@U5>`).join('\n')}\n## End\nlast line`;
    await sql`insert into subagents (id, thread_id, owner_id, title) values (${sa}, ${c.threadId}, 'USPEAK', 'Research')`;
    await sql`insert into runs (subagent_id, thread_id, instructions, status, result) values
      (${sa}, ${c.threadId}, 'x', 'complete', 'old result'), (${sa}, ${c.threadId}, 'y', 'complete', ${longDoc}), (${sa}, ${c.threadId}, 'z', 'error', null)`;
    const out = await exec('front', c, 'create_canvas', { title: 'Report', content: 'Short intro.', from_subagent: sa });
    const id = linkOf(out)![2]!;
    const md = content.get(id)!;
    expect(md.startsWith('Short intro.\n\n## Report @​channel\n- finding 0 ![](@U5)')).toBe(true);
    expect(md).toContain('last line'); // the latest complete run, in full
    expect(md).not.toContain('old result');

    // Another thread's subagent can't be published here.
    const other = await ctx(PUB);
    expect(await exec('front', other, 'create_canvas', { title: 'X', from_subagent: sa })).toMatch(/Not created: no finished result/);
    // Unknown id, and neither content nor subagent.
    expect(await exec('front', c, 'create_canvas', { title: 'X', from_subagent: 'sa_nope' })).toMatch(/Not created: no finished result/);
    expect(await exec('front', c, 'create_canvas', { title: 'X' })).toMatch(/content is empty/);

    // Too long for a canvas: cut with a note, not refused.
    const sa2 = `sa_cv${rand().toLowerCase()}`;
    await sql`insert into subagents (id, thread_id, owner_id, title) values (${sa2}, ${c.threadId}, 'USPEAK', 'Huge')`;
    await sql`insert into runs (subagent_id, thread_id, instructions, status, result) values (${sa2}, ${c.threadId}, 'x', 'complete', ${'line\n'.repeat(30_000)})`;
    const huge = await exec('front', c, 'create_canvas', { title: 'Huge', from_subagent: sa2 });
    expect(huge).toMatch(/was cut/);
    expect(content.get(linkOf(huge)![2]!)!.length).toBeLessThanOrEqual(100_000);

    // edit_canvas append takes it too.
    calls = [];
    expect(await exec('front', c, 'edit_canvas', { canvas: id, action: 'append', from_subagent: sa, content: '## Again' })).toMatch(/Canvas updated/);
    expect(callsOf('canvases.edit')[0]!.args.changes[0].document_content.markdown).toContain('## Again\n\n## Report @​channel');
  });

  it('from_files: publishes text files joined in order (the read_file access rule); not together with from_subagent', async () => {
    const c = await ctx(PUB);
    const { createFile } = await import('../files/store.js');
    const mk = (name: string, text: string, threadId = c.threadId, ownerId = 'USPEAK') =>
      createFile({ threadId, ownerId, name, content: Buffer.from(text), description: name, createdRunId: null, createdTurnId: null, createdSubagentId: null });
    const p1 = await mk('p1.md', '## Part 1\none');
    const p2 = await mk('p2.md', '## Part 2\ntwo <!channel>');
    const out = await exec('front', c, 'create_canvas', { title: 'Joined', content: 'Intro.', from_files: [p1.id, p2.id] });
    expect(out).toContain('Published 2 files: p1.md, p2.md');
    expect(content.get(linkOf(out)![2]!)).toBe('Intro.\n\n## Part 1\none\n\n## Part 2\ntwo @\u200bchannel\n');
    const foreign = await mk('secret.md', 'nope', `${PUB}:1790000999.000100`, 'USOMEONE');
    expect(await exec('front', c, 'create_canvas', { title: 'X', from_files: [foreign.id] })).toMatch(/^Not created: No file/);
    expect(await exec('front', c, 'create_canvas', { title: 'X', from_files: [p1.id], from_subagent: 'sa_x' })).toMatch(/not both/);
    calls = [];
    const id = linkOf(out)![2]!;
    expect(await exec('front', c, 'edit_canvas', { canvas: id, action: 'append', from_files: [p2.id] })).toMatch(/Canvas updated/);
    expect(callsOf('canvases.edit')[0]!.args.changes[0].document_content.markdown).toContain('## Part 2');
  });

  it('edit: a deleted canvas drops its row', async () => {
    const c = await ctx(PUB);
    const id = linkOf(await exec('front', c, 'create_canvas', { title: 'Gone', content: 'a' }))![2]!;
    content.delete(id);
    expect(await exec('front', c, 'edit_canvas', { canvas: id, action: 'append', content: 'b' })).toMatch(/no longer exists/);
    expect(await sql`select 1 from bot_canvases where canvas_id = ${id}`).toHaveLength(0);
  });

  it('read: own canvas in its conversation, converted and wrapped as untrusted', async () => {
    const c = await ctx(PUB);
    const id = linkOf(await exec('front', c, 'create_canvas', { title: 'Doc', content: 'hello <@U77>' }))![2]!;
    calls = [];
    const out = await exec('child', c, 'read_canvas', { canvas: id });
    // The title (typed by whoever made the canvas) is inside the untrusted wrapper, not in the trusted header.
    const [head, wrapped] = out.split('<untrusted_content source="slack canvas">');
    expect(head).toContain(`Canvas ${id}`);
    expect(head).not.toContain('Doc');
    expect(wrapped).toContain('Title: Doc');
    expect(out).toContain('hello <@U77>');
    expect(callsOf('files.info')).toHaveLength(0); // no lookup needed
  });

  it('read: access rule by where the canvas is shared (private channels refused)', async () => {
    const mk = (f: object) => {
      const id = `F${rand()}${rand()}`;
      content.set(id, `# secret ${id}`);
      files.set(id, { id, title: 't', ...f });
      return id;
    };
    const inPriv = mk({ groups: [PRIV], shares: { private: { [PRIV]: [] } } });
    const inPub = mk({ channels: [OTHERPUB], shares: { public: { [OTHERPUB]: [] } } });
    const inDmElsewhere = mk({ ims: [`D${rand()}`] });

    const here = await ctx(PUB);
    expect(await exec('front', here, 'read_canvas', { canvas: inPriv })).toBe(C.READ_REFUSED);
    expect(await exec('front', here, 'read_canvas', { canvas: inDmElsewhere })).toBe(C.READ_REFUSED);
    expect(callsOf('canvases.getContent')).toHaveLength(0);
    expect(await exec('front', here, 'read_canvas', { canvas: inPub })).toContain(`secret ${inPub}`);
    // In the private channel itself it's fine.
    expect(await exec('front', await ctx(PRIV), 'read_canvas', { canvas: inPriv })).toContain(`secret ${inPriv}`);
    // Invisible to the bot / not a canvas link.
    expect(await exec('front', here, 'read_canvas', { canvas: `F${rand()}${rand()}` })).toBe(C.READ_REFUSED);
    expect(await exec('front', here, 'read_canvas', { canvas: 'https://example.com/docs/T1/F1234567' })).toBe(C.NOT_A_CANVAS);
  });

  it("read: the bot's canvas from a DM / private channel stays there, also for its creator", async () => {
    const id = linkOf(await exec('front', await ctx(DM, 'UDMOWNER'), 'create_canvas', { title: 'Diary', content: 'private' }))![2]!;
    expect(await exec('front', await ctx(PUB, 'UOTHER'), 'read_canvas', { canvas: id })).toBe(C.READ_REFUSED);
    expect(await exec('front', await ctx(PUB, 'UDMOWNER'), 'read_canvas', { canvas: id })).toBe(C.READ_REFUSED);
    expect(await exec('front', await ctx(DM, 'UDMOWNER'), 'read_canvas', { canvas: id })).toContain('private');
    const priv = linkOf(await exec('front', await ctx(PRIV, 'UPRIVOWNER'), 'create_canvas', { title: 'Staff', content: 'staff only' }))![2]!;
    expect(await exec('front', await ctx(PUB, 'UPRIVOWNER'), 'read_canvas', { canvas: priv })).toBe(C.READ_REFUSED);
    // One made in a public channel can be read anywhere.
    const pub = linkOf(await exec('front', await ctx(PUB, 'UPUBOWNER'), 'create_canvas', { title: 'Open', content: 'open notes' }))![2]!;
    expect(await exec('front', await ctx(OTHERPUB, 'UOTHER'), 'read_canvas', { canvas: pub })).toContain('open notes');
  });

  it('read: long canvases page with offset', async () => {
    const id = `F${rand()}${rand()}`;
    const long = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
    content.set(id, long);
    files.set(id, { id, channels: [PUB] });
    const c = await ctx(PUB);
    let out = await exec('front', c, 'read_canvas', { canvas: id });
    expect(out).toContain('line 0 ');
    expect(out).not.toContain('line 3999');
    let pages = 1;
    for (let m = /offset=(\d+)/.exec(out); m; m = /offset=(\d+)/.exec(out), pages++) {
      out = await exec('front', c, 'read_canvas', { canvas: id, offset: Number(m[1]) });
    }
    expect(pages).toBeGreaterThan(2);
    expect(out).toContain('line 3999');
  });
});
