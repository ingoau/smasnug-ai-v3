/**
 * Integration tests against the real Postgres/Redis from .env with SLACK_FAKE=1.
 * Run: INTEGRATION=1 pnpm vitest run src/features/features.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.ADMIN_USER_ID = 'UADMIN';
    process.env.MOD_CHANNEL_ID = 'CMOD';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../agent/files.js', () => ({ uploadFiles: vi.fn(async () => {}) }));

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const uid = () => `UT${rand()}`;

describe.skipIf(!INTEGRATION)('features integration', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  let send: typeof import('./send/send.js');
  let guard: typeof import('./guard.js');
  let state: typeof import('./state.js');
  let reports: typeof import('./reports.js');
  let tools: typeof import('./memory/tools.js');
  let render: typeof import('./memory/render.js');
  let home: typeof import('./home.js');
  let killswitch: typeof import('./killswitch.js');
  let workspace: typeof import('./workspace.js');
  let retention: typeof import('./retention.js');
  let uploadFiles: any;

  const threadId = `CTEST${rand()}:1700000000.000100`;
  const [channelId, threadTs] = threadId.split(':') as [string, string];

  const toolCtx = (speakerId: string) => ({ role: 'front' as const, threadId, channelId, threadTs, speakerId, turnId: Math.floor(Math.random() * 1e9), extras: {} });
  const exec = (t: any, input: object) => t.execute(input, { toolCallId: 'tc', messages: [] });
  const action = (o: { userId: string; actionId: string; value?: string; body?: any; channelId?: string; messageTs?: string }) => ({
    responseUrl: `https://hooks.fake/${rand()}`,
    body: {},
    ...o,
  });
  const callsSince = async (n: number) => (await fakeCalls()).slice(n);
  const lastResponse = async (n: number) => (await callsSince(n)).filter((c) => c.method === 'response_url').at(-1)?.args;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    send = await import('./send/send.js');
    guard = await import('./guard.js');
    state = await import('./state.js');
    reports = await import('./reports.js');
    tools = await import('./memory/tools.js');
    render = await import('./memory/render.js');
    home = await import('./home.js');
    killswitch = await import('./killswitch.js');
    workspace = await import('./workspace.js');
    retention = await import('./retention.js');
    uploadFiles = (await import('../agent/files.js')).uploadFiles;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channelId}, ${threadTs}) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from threads where id = ${threadId}`;
    await sql.end();
    redis.disconnect();
  });

  beforeEach(async () => {
    await state.setPaused(false);
  });

  describe('send_message', () => {
    it('posts in the current thread directly', async () => {
      const n = (await fakeCalls()).length;
      const res = await exec(send.sendMessageTool(toolCtx(uid())), { destination: 'thread', text: 'hi there' });
      expect(res).toMatch(/Posted/);
      const post = (await callsSince(n)).find((c) => c.method === 'chat.postMessage');
      expect(post?.args).toMatchObject({ channel: channelId, thread_ts: threadTs });
      expect(post?.args.username).toBeUndefined();
    });

    it('confirms, refuses other users, sends attributed, refuses stale clicks', async () => {
      const requester = uid();
      const n = (await fakeCalls()).length;
      const res = await exec(send.sendMessageTool(toolCtx(requester)), { destination: '#general', text: 'Meeting at 5 <!channel>', files: [{ filename: 'a.txt', content: 'x' }] });
      expect(res).toMatch(/Awaiting confirmation/);

      const [pending] = await sql<any[]>`select * from pending_sends where requester_id = ${requester}`;
      expect(pending).toMatchObject({ destination: 'CGENERAL', status: 'pending', threadId });
      expect(pending.text).not.toContain('<!channel>');
      const eph = (await callsSince(n)).find((c) => c.method === 'chat.postEphemeral');
      expect(eph?.args.user).toBe(requester);
      const buttons = eph?.args.blocks.find((b: any) => b.type === 'actions').elements;
      expect(buttons.map((b: any) => [b.action_id, b.value])).toEqual([
        ['send:confirm', pending.id],
        ['send:cancel', pending.id],
      ]);

      // wrong user
      let m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: uid(), actionId: 'send:confirm', value: pending.id }));
      expect((await lastResponse(m))?.text).toMatch(/Only the person who asked/);
      expect((await sql`select status from pending_sends where id = ${pending.id}`)[0]!.status).toBe('pending');

      // requester confirms
      m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: pending.id }));
      const calls = await callsSince(m);
      const post = calls.find((c) => c.method === 'chat.postMessage');
      expect(post?.args.channel).toBe('CGENERAL');
      const { env } = await import('../config.js');
      expect(post?.args.username).toBe(`${env.BOT_DISPLAY_NAME} on behalf of User ${requester}`);
      expect(post?.args.icon_url).toBe('https://example.com/a.png');
      const [sent] = await sql<any[]>`select * from sent_messages where requester_id = ${requester}`;
      expect(sent).toMatchObject({ channelId: 'CGENERAL', destination: 'CGENERAL', pendingSendId: pending.id });
      expect(sent.permalink).toContain('fake.slack.com');
      const report = post?.args.blocks.find((b: any) => b.type === 'actions').elements[0];
      expect(report).toMatchObject({ action_id: 'report:open', value: String(sent.id) });
      expect(JSON.stringify(post?.args.blocks)).toContain(`Sent by <@${requester}> via ${env.BOT_DISPLAY_NAME}`);
      expect(uploadFiles).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'CGENERAL', threadTs: post?.args && sent.ts }));
      expect((await lastResponse(m))).toMatchObject({ replace_original: true });
      expect((await lastResponse(m))?.text).toMatch(/^Sent ✓/);
      const [ev] = await sql<any[]>`select * from thread_events where thread_id = ${threadId} and type = 'send' and actor = ${requester}`;
      expect(ev?.payload.sentMessageId).toBe(Number(sent.id));
      expect(Number((await sql`select count(*)::int as n from usage where user_id = ${requester} and kind = 'send'`)[0]!.n)).toBe(1);

      // stale double click
      m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: pending.id }));
      expect((await lastResponse(m))?.text).toBe('Already sent.');
      expect((await callsSince(m)).some((c) => c.method === 'chat.postMessage')).toBe(false);
    });

    it('expired and unknown pending sends say "This expired, ask again."', async () => {
      const requester = uid();
      const [p] = await sql<any[]>`
        insert into pending_sends (requester_id, destination, text, expires_at)
        values (${requester}, 'CGENERAL', 'late', now() - interval '1 second') returning id`;
      let m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: p!.id }));
      expect(await lastResponse(m)).toMatchObject({ replace_original: true, text: 'This expired, ask again.' });
      expect((await callsSince(m)).some((c) => c.method === 'chat.postMessage')).toBe(false);

      m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: 'not-a-uuid' }));
      expect((await lastResponse(m))?.text).toBe('This expired, ask again.');
    });

    it('cancel only by the requester', async () => {
      const requester = uid();
      await exec(send.sendMessageTool(toolCtx(requester)), { destination: 'CGENERAL', text: 'cancel me' });
      const [p] = await sql<any[]>`select id from pending_sends where requester_id = ${requester}`;
      await send.handleSendCancel(action({ userId: uid(), actionId: 'send:cancel', value: p!.id }));
      expect((await sql`select status from pending_sends where id = ${p!.id}`)[0]!.status).toBe('pending');
      await send.handleSendCancel(action({ userId: requester, actionId: 'send:cancel', value: p!.id }));
      expect((await sql`select status from pending_sends where id = ${p!.id}`)[0]!.status).toBe('cancelled');
      const m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: p!.id }));
      expect((await lastResponse(m))?.text).toBe('Cancelled.');
    });

    it('DMs go through conversations.open at send time', async () => {
      const requester = uid();
      const target = uid();
      await exec(send.sendMessageTool(toolCtx(requester)), { destination: `<@${target}>`, text: 'psst' });
      const [p] = await sql<any[]>`select * from pending_sends where requester_id = ${requester}`;
      expect(p.destination).toBe(target);
      const m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: p.id }));
      const calls = await callsSince(m);
      expect(calls.find((c) => c.method === 'conversations.open')?.args.users).toBe(target);
      expect(calls.find((c) => c.method === 'chat.postMessage')?.args.channel).toBe(`D${target}`);
    });

    it('refuses DM channel ids other than the current one', async () => {
      const res = await exec(send.sendMessageTool(toolCtx(uid())), { destination: 'D0999ZZZ', text: 'x' });
      expect(res).toMatch(/user id or mention/);
    });

    it('send-blocked users are refused before and at confirmation', async () => {
      const requester = uid();
      await exec(send.sendMessageTool(toolCtx(requester)), { destination: 'CGENERAL', text: 'before block' });
      const [p] = await sql<any[]>`select id from pending_sends where requester_id = ${requester}`;
      await state.setBlock(requester, { sendBlocked: true, reason: 'test' });
      const res = await exec(send.sendMessageTool(toolCtx(requester)), { destination: 'CGENERAL', text: 'after block' });
      expect(res).toMatch(/blocked/);
      const m = (await fakeCalls()).length;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: p!.id }));
      expect((await lastResponse(m))?.text).toMatch(/blocked/);
      expect((await callsSince(m)).some((c) => c.method === 'chat.postMessage')).toBe(false);
      await state.setBlock(requester, { sendBlocked: false });
    });
  });

  describe('reports and auto-suspension', () => {
    async function sendAs(requester: string) {
      await exec(send.sendMessageTool(toolCtx(requester)), { destination: 'CGENERAL', text: `msg ${rand()}` });
      const [p] = await sql<any[]>`select id from pending_sends where requester_id = ${requester} and status = 'pending' order by created_at desc limit 1`;
      await send.handleSendConfirm(action({ userId: requester, actionId: 'send:confirm', value: p!.id }));
      const [s] = await sql<any[]>`select * from sent_messages where pending_send_id = ${p!.id}`;
      return s;
    }

    it('suspends after distinct reporters reach the threshold; duplicates and self-reports do not count', async () => {
      const sender = uid();
      const s1 = await sendAs(sender);
      const s2 = await sendAs(sender);
      const r1 = uid(), r2 = uid(), r3 = uid();

      let m = (await fakeCalls()).length;
      await reports.handleReport(action({ userId: r1, actionId: 'report:open', value: String(s1.id) }));
      expect((await lastResponse(m))?.text).toBe('Thanks, reported.');
      const modPost = (await callsSince(m)).find((c) => c.method === 'chat.postMessage' && c.args.channel === 'CMOD');
      expect(JSON.stringify(modPost?.args.blocks)).toContain('mod:delete');
      expect(JSON.stringify(modPost?.args.blocks)).toContain('mod:block_send');

      m = (await fakeCalls()).length;
      await reports.handleReport(action({ userId: r1, actionId: 'report:open', value: String(s2.id) })); // same reporter, other msg
      await reports.handleReport(action({ userId: r1, actionId: 'report:open', value: String(s1.id) })); // duplicate
      expect((await lastResponse(m))?.text).toMatch(/already reported/);
      await reports.handleReport(action({ userId: sender, actionId: 'report:open', value: String(s1.id) })); // self
      await reports.handleReport(action({ userId: r2, actionId: 'report:open', value: String(s2.id) }));
      expect(await reports.countDistinctReporters(sender)).toBe(2);
      expect(await guard.checkEntry(sender, undefined, { countMessage: false })).toEqual({ ok: true });

      m = (await fakeCalls()).length;
      await reports.handleReport(action({ userId: r3, actionId: 'report:open', value: String(s1.id) }));
      state.invalidateState();
      expect(await guard.checkEntry(sender, undefined, { countMessage: false })).toEqual({ ok: false, reason: 'suspended' });
      const notice = (await callsSince(m)).find((c) => c.method === 'chat.postMessage' && JSON.stringify(c.args.blocks).includes('mod:unsuspend'));
      expect(notice).toBeTruthy();

      // non-admin can't unsuspend
      m = (await fakeCalls()).length;
      await reports.handleModAction(action({ userId: r1, actionId: 'mod:unsuspend', value: sender }), async () => {});
      expect((await lastResponse(m))?.text).toBe('Only the admin can do that.');
      state.invalidateState();
      expect((await guard.checkEntry(sender, undefined, { countMessage: false })).ok).toBe(false);

      // admin unsuspends; old reports are reviewed, so one new report doesn't re-suspend
      await reports.handleModAction(action({ userId: 'UADMIN', actionId: 'mod:unsuspend', value: sender, channelId: 'CMOD', messageTs: '1.1' }), async () => {});
      expect(await guard.checkEntry(sender, undefined, { countMessage: false })).toEqual({ ok: true });
      await reports.handleReport(action({ userId: uid(), actionId: 'report:open', value: String(s2.id) }));
      expect(await guard.checkEntry(sender, undefined, { countMessage: false })).toEqual({ ok: true });

      // report keeps the original sender/text even after the message is deleted
      await reports.handleModAction(action({ userId: 'UADMIN', actionId: 'mod:delete', value: String(s1.id), channelId: 'CMOD', messageTs: '1.1' }), async () => {});
      const [snap] = await sql<any[]>`select snapshot from reports where sent_message_id = ${s1.id} and reporter_id = ${r1}`;
      expect(snap.snapshot).toMatchObject({ senderId: sender, text: s1.text });
    });

    it('block_send by admin blocks only the send tool', async () => {
      const sender = uid();
      await reports.handleModAction(action({ userId: 'UADMIN', actionId: 'mod:block_send', value: sender }), async () => {});
      expect(await guard.takeLimit('send', sender)).toMatch(/blocked/);
      expect(await guard.checkEntry(sender, undefined, { countMessage: false })).toEqual({ ok: true });
    });
  });

  describe('guard', () => {
    it('pause blocks everyone but the admin', async () => {
      await state.setPaused(true);
      expect(await guard.checkEntry(uid(), 'C1', { countMessage: false })).toEqual({ ok: false, reason: 'paused' });
      expect(await guard.checkEntry('UADMIN', 'C1', { countMessage: false })).toEqual({ ok: true });
      await state.setPaused(false);
    });

    it('messages per hour', async () => {
      const u = uid();
      const { limits } = await import('../config.js');
      for (let i = 0; i < limits.userMessagesPerHour; i++) expect((await guard.checkEntry(u)).ok).toBe(true);
      expect(await guard.checkEntry(u)).toEqual({ ok: false, reason: 'rate_limited' });
      expect(await guard.checkEntry(u, undefined, { countMessage: false })).toEqual({ ok: true });
    });

    it('hourly sends and subagent concurrency', async () => {
      const u = uid();
      const { limits } = await import('../config.js');
      for (let i = 0; i < limits.userSendsPerHour; i++) expect(await guard.takeLimit('send', u)).toBeNull();
      expect(await guard.takeLimit('send', u)).toMatch(/Limit reached/);
      expect(await guard.peekLimit('send', u)).toMatch(/Limit reached/);

      for (let i = 0; i < limits.userConcurrentSubagents; i++) {
        const sa = `sa_${rand()}`;
        await sql`insert into subagents (id, thread_id, owner_id, title, status) values (${sa}, ${threadId}, ${u}, 't', 'running')`;
        await sql`insert into runs (subagent_id, thread_id, instructions, status) values (${sa}, ${threadId}, 'x', 'running')`;
      }
      expect(await guard.takeLimit('subagent', u, threadId)).toMatch(/this user already has/);
      expect(await guard.takeLimit('subagent', uid(), `${threadId}x`)).toBeNull();
      await guard.recordModelUsage({ userId: u, model: 'm', inputTokens: 5, outputTokens: 6 });
      expect((await sql`select count(*)::int as n from usage where user_id = ${u} and kind = 'model'`)[0]!.n).toBe(1);
    });

    it('/smasnug off|on: only creator or admin', async () => {
      const ch = `CK${rand()}`;
      let m = (await fakeCalls()).length;
      await killswitch.handleSlash(action({ userId: uid(), actionId: 'slash:/smasnug', channelId: ch, body: { text: 'off', command: '/smasnug' } }) as any);
      expect((await lastResponse(m))?.text).toMatch(/Only the channel's creator/);
      await killswitch.handleSlash(action({ userId: 'UADMIN', actionId: 'slash:/smasnug', channelId: ch, body: { text: 'off', command: '/smasnug' } }) as any);
      expect(await guard.checkEntry(uid(), ch, { countMessage: false })).toEqual({ ok: false, reason: 'channel_disabled' });
      m = (await fakeCalls()).length;
      await killswitch.handleSlash(action({ userId: uid(), actionId: 'slash:/smasnug', channelId: ch, body: { text: 'status' } }) as any);
      expect((await lastResponse(m))?.text).toMatch(/\*off\*/);
      await killswitch.handleSlash(action({ userId: 'UADMIN', actionId: 'slash:/smasnug', channelId: ch, body: { text: 'on' } }) as any);
      expect(await guard.checkEntry(uid(), ch, { countMessage: false })).toEqual({ ok: true });
    });
  });

  describe('memory and workspace facts', () => {
    it('remember/forget are scoped to the speaker', async () => {
      const a = uid(), b = uid();
      const saved = await exec(tools.rememberTool(toolCtx(a)), { fact: 'prefers short answers' });
      const id = /m_(\d+)/.exec(saved)![1]!;
      expect(await exec(tools.rememberTool(toolCtx(a)), { fact: 'Prefers short answers' })).toMatch(/Already remembered/);
      expect(await exec(tools.forgetTool(toolCtx(b)), { fact_id: `m_${id}` })).toMatch(/No fact/);
      const mem = await render.renderSpeakerMemory(a);
      expect(mem).toContain(`[m_${id}] prefers short answers`);
      expect(mem).toMatch(/private/i);
      expect(await render.renderSpeakerMemory(b)).toBe('');
      expect(await exec(tools.forgetTool(toolCtx(a)), { fact_id: Number(id) })).toMatch(/Forgot/);
      expect(await render.renderSpeakerMemory(a)).toBe('');
    });

    it('App Home lists own facts; mem:delete only deletes own; forget_all', async () => {
      const a = uid(), b = uid();
      await exec(tools.rememberTool(toolCtx(a)), { fact: 'likes cats' });
      await exec(tools.rememberTool(toolCtx(a)), { fact: 'likes dogs' });
      const [bf] = await sql<any[]>`insert into user_memory (user_id, text) values (${b}, 'b fact') returning id`;
      let m = (await fakeCalls()).length;
      await home.publishHome(a);
      const view = (await callsSince(m)).find((c) => c.method === 'views.publish')?.args;
      expect(view.user_id).toBe(a);
      const s = JSON.stringify(view.view.blocks);
      expect(s).toContain('likes cats');
      expect(s).toContain('mem:forget_all');
      expect(s).not.toContain('Admin');
      await home.handleMemoryAction(action({ userId: a, actionId: 'mem:delete', value: String(bf!.id) }));
      expect((await sql`select id from user_memory where id = ${bf!.id}`).length).toBe(1);
      await home.handleMemoryAction(action({ userId: a, actionId: 'mem:forget_all', value: 'all' }));
      expect((await sql`select id from user_memory where user_id = ${a}`).length).toBe(0);
      await sql`delete from user_memory where user_id = ${b}`;
      m = (await fakeCalls()).length;
      await home.publishHome('UADMIN');
      const adminView = JSON.stringify((await callsSince(m)).find((c) => c.method === 'views.publish')?.args.view.blocks);
      expect(adminView).toContain('admin:pause');
    });

    it('workspace facts: propose → mod channel → admin approve → rendered', async () => {
      const text = `#ship-${rand()} is for showing finished projects`;
      const m = (await fakeCalls()).length;
      expect(await exec(tools.proposeWorkspaceFactTool(toolCtx(uid())), { fact: text })).toMatch(/approval/);
      const post = (await callsSince(m)).find((c) => c.method === 'chat.postMessage' && c.args.channel === 'CMOD');
      expect(JSON.stringify(post?.args.blocks)).toContain('fact:approve');
      const [f] = await sql<any[]>`select * from workspace_facts where text = ${text}`;
      expect(f.status).toBe('pending');
      expect(f.modMessageTs).toBeTruthy();
      expect(await render.renderWorkspaceFacts()).not.toContain(text);

      await workspace.handleFactAction(action({ userId: uid(), actionId: 'fact:approve', value: String(f.id) }), async () => {});
      expect((await sql`select status from workspace_facts where id = ${f.id}`)[0]!.status).toBe('pending');
      await workspace.handleFactAction(action({ userId: 'UADMIN', actionId: 'fact:approve', value: String(f.id) }), async () => {});
      expect(await render.renderWorkspaceFacts()).toContain(text);
      await workspace.handleFactAction(action({ userId: 'UADMIN', actionId: 'fact:delete', value: String(f.id) }), async () => {});
      expect(await render.renderWorkspaceFacts()).not.toContain(text);
    });
  });

  describe.skipIf(process.env.LIVE !== '1')('live extraction end-to-end (LIVE=1)', () => {
    it('extracts facts for participants of an idle thread, only from their own messages', async () => {
      const t = `CLIVE${rand()}:1700000001.000100`;
      const alice = uid(), sam = uid();
      await sql`insert into threads (id, channel_id, thread_ts, last_activity_at) values (${t}, 'CLIVE', '1700000001.000100', now() - interval '1 hour')`;
      const msgs: [string, string | null, string | null, string][] = [
        ['1700000001.000100', alice, null, "<@UBOT> I'm building a solar-powered weather station for Blueprint and I mostly code in Rust. Keep answers short please."],
        ['1700000001.000200', null, 'BBOT', 'Nice! An ESP32-C3 with a BME280 works well; esp-hal has good Rust support.'],
        ['1700000001.000300', sam, null, "Alice also does 3D printing and is really into Python, she's been struggling with her exams"],
        ['1700000001.000400', alice, null, 'Thanks! Also my timezone is CET if that matters for scheduling.'],
      ];
      for (const [ts, user, bot, text] of msgs)
        await sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, text) values ('CLIVE', ${ts}, ${t}, ${user}, ${bot}, ${text})`;
      await sql`insert into turns (thread_id, author_id, kind, status, created_at) values (${t}, ${alice}, 'user', 'done', now() - interval '1 hour')`;

      const { runMemoryExtraction } = await import('./memory/extract.js');
      await runMemoryExtraction();
      const facts = await sql<any[]>`select user_id, text from user_memory where user_id in (${alice}, ${sam})`;
      console.log(facts);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.every((f) => f.userId === alice)).toBe(true); // sam didn't talk to the bot; nothing for him
      expect(facts.map((f) => f.text).join(' ').toLowerCase()).not.toMatch(/python|3d|exam|struggl/);
      const [th] = await sql<any[]>`select memory_extracted_at from threads where id = ${t}`;
      expect(th.memoryExtractedAt).toBeTruthy();
      await sql`delete from threads where id = ${t}`;
      await sql`delete from user_memory where user_id = ${alice}`;
    }, 90_000);
  });

  describe('retention', () => {
    it('deletes old threads, coordination rows and stale memory; keeps recent', async () => {
      const old = `COLD${rand()}:1.0`;
      await sql`insert into threads (id, channel_id, thread_ts, last_activity_at) values (${old}, 'COLD', '1.0', now() - interval '40 days')`;
      await sql`insert into thread_events (thread_id, type) values (${old}, 'message')`;
      const key = `test:${rand()}`;
      await sql`insert into idempotency_keys (key, created_at) values (${key}, now() - interval '3 days')`;
      const u = uid();
      await sql`insert into user_memory (user_id, text, last_used) values (${u}, 'stale', now() - interval '200 days'), (${u}, 'fresh', now())`;
      await retention.runRetention();
      expect((await sql`select id from threads where id = ${old}`).length).toBe(0);
      expect((await sql`select id from threads where id = ${threadId}`).length).toBe(1);
      expect((await sql`select key from idempotency_keys where key = ${key}`).length).toBe(0);
      expect((await sql<any[]>`select text from user_memory where user_id = ${u}`).map((r) => r.text)).toEqual(['fresh']);
      await sql`delete from user_memory where user_id = ${u}`;
    });
  });
});
