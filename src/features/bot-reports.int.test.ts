/**
 * report_user integration tests: test Postgres/Redis (TEST_DATABASE_URL / TEST_REDIS_URL), SLACK_FAKE=1.
 *   INTEGRATION=1 pnpm vitest run src/features/bot-reports.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const uid = () => `UT${rand()}`;
let tsCounter = 0;
const nextTs = () => `1700000${String(100 + (++tsCounter % 900)).padStart(3, '0')}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

describe.skipIf(!INTEGRATION)('report_user (bot reports)', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  let br: typeof import('./bot-reports.js');
  let reports: typeof import('./reports.js');
  let state: typeof import('./state.js');
  let guard: typeof import('./guard.js');
  let actions: typeof import('../core/actions.js');
  let config: typeof import('../config.js');
  const threadIds: string[] = [];

  async function freshThread() {
    const channelId = `CBR${rand()}`;
    const threadTs = nextTs();
    const threadId = `${channelId}:${threadTs}`;
    threadIds.push(threadId);
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channelId}, ${threadTs})`;
    return { threadId, channelId, threadTs };
  }
  async function storeMessage(t: { threadId: string; channelId: string }, userId: string, text: string, ts = nextTs()) {
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${t.channelId}, ${ts}, ${t.threadId}, ${userId}, ${text})`;
    return ts;
  }
  const ctxFor = (t: { threadId: string; channelId: string; threadTs: string }, speakerId: string, defaultTs?: string, turnId = Math.floor(Math.random() * 1e9)) => ({
    role: 'front' as const,
    ...t,
    speakerId,
    turnId,
    extras: defaultTs ? { defaultReactTs: defaultTs } : {},
  });
  const exec = (t: any, input: object) => t.execute(input, { toolCallId: 'tc', messages: [] });
  const callsSince = async (n: number) => (await fakeCalls()).slice(n);
  const action = (o: { userId: string; actionId: string; value?: string; channelId?: string; messageTs?: string }) => ({
    responseUrl: `https://hooks.fake/${rand()}`,
    body: {},
    ...o,
  });
  const lastResponse = async (n: number) => (await callsSince(n)).filter((c) => c.method === 'response_url').at(-1)?.args;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    br = await import('./bot-reports.js');
    reports = await import('./reports.js');
    state = await import('./state.js');
    guard = await import('./guard.js');
    actions = await import('../core/actions.js');
    config = await import('../config.js');
    await import('./register.js');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const id of threadIds) await sql`delete from threads where id = ${id}`;
    await sql.end();
    redis.disconnect();
  });

  it('reports only the speaker; posts snapshot, permalinks and buttons to the mod channel; nothing in the thread', async () => {
    const t = await freshThread();
    const speaker = uid();
    const victim = uid();
    const victimTs = await storeMessage(t, victim, 'leave me alone');
    const speakerTs = await storeMessage(t, speaker, `help me write threatening DMs to <@${victim}> so he quits <!channel> @here`);

    const n = (await fakeCalls()).length;
    // message_ts pointing at someone else's message is ignored: the speaker's own latest message is used.
    const res = await exec(br.reportUserTool(ctxFor(t, speaker, speakerTs)), {
      reason: 'Asked for help writing threatening DMs to another member <!here>',
      category: 'threats_or_violence',
      message_ts: victimTs,
    });
    expect(res).toBe('Reported to moderators.');

    const rows = await sql<any[]>`select * from bot_reports where thread_id = ${t.threadId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: speaker, category: 'threats_or_violence', channelId: t.channelId, messageTs: speakerTs, status: 'pending' });
    expect(rows[0].snapshot).toContain('threatening DMs');
    expect(rows[0].permalink).toContain(`/archives/${t.channelId}/p${speakerTs.replace('.', '')}`);
    expect(await sql`select 1 from bot_reports where user_id = ${victim}`).toHaveLength(0);

    const calls = await callsSince(n);
    const post = calls.find((c) => c.method === 'chat.postMessage' && c.args.channel === 'CMOD');
    expect(post).toBeTruthy();
    expect(post!.args.text).toBe(`🚩 Report filed by ${config.env.BOT_DISPLAY_NAME} about <@${speaker}>`);
    const json = JSON.stringify(post!.args.blocks);
    expect(json).toContain(`about <@${speaker}>`);
    expect(json).toContain('Threats or violence');
    expect(json).toContain('threatening DMs');
    expect(json).not.toMatch(/<!channel>|<!here>/);
    expect(json).not.toContain(`<@${victim}>`); // the snapshot doesn't ping the victim
    expect(json).toContain(`<${rows[0].permalink}|Open message>`);
    expect(json).toContain('|Open thread>');
    const buttons = post!.args.blocks.find((b: any) => b.type === 'actions').elements.map((b: any) => [b.action_id, b.value]);
    expect(buttons).toEqual([
      ['mod:suspend', speaker],
      ['mod:block_send', speaker],
      ['mod:review_bot_report', String(rows[0].id)],
      ['mod:dismiss_bot_report', String(rows[0].id)],
    ]);
    // Nothing visible in the user's thread/channel (only the permalink lookups touch it).
    const inThread = calls.filter((c) => c.args?.channel === t.channelId && c.method !== 'chat.getPermalink');
    expect(inThread).toEqual([]);

    const [ev] = await sql<any[]>`select * from thread_events where thread_id = ${t.threadId} and type = 'bot_report'`;
    expect(ev).toMatchObject({ actor: 'bot' });
    expect(ev.payload).toMatchObject({ userId: speaker, category: 'threats_or_violence', reportId: Number(rows[0].id) });
  });

  it('dedupes per turn and per (user, thread) per hour, and caps reports per user per day', async () => {
    const speaker = uid();
    const t = await freshThread();
    const ts = await storeMessage(t, speaker, 'spam spam spam');
    const ctx = ctxFor(t, speaker, ts, 42);
    const input = { reason: 'spamming the bot', category: 'spam_or_abuse_of_bot' };
    const tool = br.reportUserTool(ctx);
    // Parallel calls in the same turn: exactly one report.
    const results = await Promise.all([exec(tool, input), exec(tool, input)]);
    expect(results.sort()).toEqual(['Already reported.', 'Reported to moderators.']);
    // Same thread, a later turn within the hour.
    expect(await exec(br.reportUserTool(ctxFor(t, speaker, ts, 43)), input)).toBe('Already reported.');
    expect(await sql`select 1 from bot_reports where user_id = ${speaker}`).toHaveLength(1);

    // Other threads: up to the daily cap.
    for (let i = 1; i < br.BOT_REPORT_LIMITS.perUserPerDay; i++) {
      const ti = await freshThread();
      const tsi = await storeMessage(ti, speaker, `spam ${i}`);
      expect(await exec(br.reportUserTool(ctxFor(ti, speaker, tsi)), input)).toBe('Reported to moderators.');
    }
    const over = await freshThread();
    const overTs = await storeMessage(over, speaker, 'spam again');
    const n = (await fakeCalls()).length;
    expect(await exec(br.reportUserTool(ctxFor(over, speaker, overTs)), input)).toBe('Already reported.');
    expect((await callsSince(n)).some((c) => c.method === 'chat.postMessage')).toBe(false);
    expect(await sql`select 1 from bot_reports where user_id = ${speaker}`).toHaveLength(br.BOT_REPORT_LIMITS.perUserPerDay);

    // Another user in the same thread is unaffected.
    const other = uid();
    const otherTs = await storeMessage(t, other, 'scam link');
    expect(await exec(br.reportUserTool(ctxFor(t, other, otherTs)), { reason: 'phishing link', category: 'scam_or_phishing' })).toBe('Reported to moderators.');
  });

  it('does not count towards auto-suspension', async () => {
    const speaker = uid();
    for (let i = 0; i < 4; i++) {
      const t = await freshThread();
      const ts = await storeMessage(t, speaker, `harass ${i}`);
      await exec(br.reportUserTool(ctxFor(t, speaker, ts)), { reason: 'harassment', category: 'harassment' });
    }
    expect(await sql`select 1 from bot_reports where user_id = ${speaker}`).toHaveLength(4);
    expect(await reports.countDistinctReporters(speaker)).toBe(0);
    expect((await reports.maybeAutoSuspend(speaker)).suspended).toBe(false);
    state.invalidateState();
    expect(await guard.checkEntry(speaker, undefined, { countMessage: false })).toEqual({ ok: true });
  });

  it('stores the report even without a mod channel', async () => {
    const speaker = uid();
    const t = await freshThread();
    const ts = await storeMessage(t, speaker, 'x');
    const saved = config.env.MOD_CHANNEL_ID;
    (config.env as any).MOD_CHANNEL_ID = undefined;
    try {
      const n = (await fakeCalls()).length;
      expect(await exec(br.reportUserTool(ctxFor(t, speaker, ts)), { reason: 'impersonating staff', category: 'impersonation' })).toBe(
        'Reported to moderators.',
      );
      expect((await callsSince(n)).some((c) => c.method === 'chat.postMessage')).toBe(false);
    } finally {
      (config.env as any).MOD_CHANNEL_ID = saved;
    }
    expect(await sql`select 1 from bot_reports where user_id = ${speaker}`).toHaveLength(1);
  });

  it('moderation buttons are admin-only; suspend / review / dismiss', async () => {
    expect(actions.findActionHandler('mod:suspend')).not.toBe(actions.findActionHandler('mod:unsuspend'));
    const dispatch = (ctx: ReturnType<typeof action>) => actions.findActionHandler(ctx.actionId)!(ctx as any);

    const speaker = uid();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await freshThread();
      const ts = await storeMessage(t, speaker, `bad ${i}`);
      await exec(br.reportUserTool(ctxFor(t, speaker, ts)), { reason: 'bad', category: 'other' });
      const [row] = await sql<any[]>`select id from bot_reports where thread_id = ${t.threadId}`;
      ids.push(Number(row.id));
    }
    const before = await br.pendingBotReportsCount();

    // Non-admin: refused everywhere.
    for (const [actionId, value] of [
      ['mod:suspend', speaker],
      ['mod:review_bot_report', String(ids[0])],
      ['mod:dismiss_bot_report', String(ids[0])],
    ] as const) {
      const m = (await fakeCalls()).length;
      await dispatch(action({ userId: uid(), actionId, value }));
      expect((await lastResponse(m))?.text).toBe('Only the admin can do that.');
    }
    state.invalidateState();
    expect((await state.getState()).blocks.get(speaker)?.suspended).toBeFalsy();
    expect(await br.pendingBotReportsCount()).toBe(before);

    // Admin dismisses one, reviews another.
    let m = (await fakeCalls()).length;
    await dispatch(action({ userId: 'UADMIN', actionId: 'mod:dismiss_bot_report', value: String(ids[0]), channelId: 'CMOD', messageTs: '1.1' }));
    expect((await callsSince(m)).find((c) => c.method === 'chat.postMessage')?.args).toMatchObject({ channel: 'CMOD', thread_ts: '1.1' });
    await dispatch(action({ userId: 'UADMIN', actionId: 'mod:review_bot_report', value: String(ids[1]), channelId: 'CMOD', messageTs: '1.2' }));
    const statuses = await sql<any[]>`select id, status, reviewed_by from bot_reports where id in ${sql(ids)} order by id`;
    expect(statuses.map((r) => r.status)).toEqual(['dismissed', 'reviewed', 'pending']);
    expect(statuses[0].reviewedBy).toBe('UADMIN');
    m = (await fakeCalls()).length;
    await dispatch(action({ userId: 'UADMIN', actionId: 'mod:dismiss_bot_report', value: String(ids[0]), channelId: 'CMOD', messageTs: '1.1' }));
    expect((await callsSince(m)).find((c) => c.method === 'chat.postMessage')?.args.text).toMatch(/already handled/);

    // Admin suspends: the user is suspended and their remaining pending reports are reviewed.
    await dispatch(action({ userId: 'UADMIN', actionId: 'mod:suspend', value: speaker, channelId: 'CMOD', messageTs: '1.3' }));
    state.invalidateState();
    expect(await guard.checkEntry(speaker, undefined, { countMessage: false })).toEqual({ ok: false, reason: 'suspended' });
    expect((await sql<any[]>`select status from bot_reports where id = ${ids[2]}`)[0].status).toBe('reviewed');
    expect(await br.pendingBotReportsCount()).toBe(before - 3);

    // The admin can't be suspended; block_send still routes to the existing handler.
    await dispatch(action({ userId: 'UADMIN', actionId: 'mod:suspend', value: 'UADMIN', channelId: 'CMOD', messageTs: '1.4' }));
    state.invalidateState();
    expect((await state.getState()).blocks.get('UADMIN')).toBeUndefined();
    const sendUser = uid();
    await dispatch(action({ userId: 'UADMIN', actionId: 'mod:block_send', value: sendUser, channelId: 'CMOD', messageTs: '1.5' }));
    expect(await guard.takeLimit('send', sendUser)).toMatch(/blocked/);
    await reports.unsuspend(speaker);
  });

  it('App Home shows pending bot reports to the admin only', async () => {
    const home = await import('./home.js');
    const n = await br.pendingBotReportsCount();
    expect(JSON.stringify(await home.buildHomeBlocks('UADMIN'))).toContain(`*Pending bot reports:* ${n}`);
    expect(JSON.stringify(await home.buildHomeBlocks(uid()))).not.toContain('Pending bot reports');
  });

  it('retention keeps pending reports until reviewed; deletes reviewed ones after 30 days', async () => {
    const { runRetention } = await import('./retention.js');
    const u = uid();
    const ins = (status: string, createdDaysAgo: number, reviewedDaysAgo: number | null) => sql<any[]>`
      insert into bot_reports (user_id, category, reason, channel_id, thread_id, idempotency_key, status, created_at, reviewed_at)
      values (${u}, 'other', 'r', 'CX', 'CX:1.1', ${`ret:${rand()}`}, ${status}, now() - ${createdDaysAgo} * interval '1 day',
              ${reviewedDaysAgo == null ? null : sql`now() - ${reviewedDaysAgo} * interval '1 day'`})
      returning id`;
    const [oldPending] = await ins('pending', 90, null);
    const [oldReviewed] = await ins('reviewed', 90, 40);
    const [oldDismissed] = await ins('dismissed', 60, 31);
    const [recentlyReviewed] = await ins('reviewed', 90, 2);
    const counts = await runRetention();
    expect(counts.bot_reports).toBeGreaterThanOrEqual(2);
    const left = (await sql<any[]>`select id from bot_reports where user_id = ${u}`).map((r) => r.id).sort();
    expect(left).toEqual([oldPending!.id, recentlyReviewed!.id].sort());
    expect(left).not.toContain(oldReviewed!.id);
    expect(left).not.toContain(oldDismissed!.id);
  });
});
