/**
 * Reminders + watches against the test Postgres/Redis with SLACK_FAKE=1.
 * Run: INTEGRATION=1 pnpm vitest run src/features/schedule/schedule.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.ADMIN_USER_ID = 'UADMIN';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const uid = () => `US${rand()}`;

describe.skipIf(!INTEGRATION)('reminders and watches', () => {
  let sql: typeof import('../../db/index.js').sql;
  let redis: typeof import('../../core/redis.js').redis;
  let fake: typeof import('../../core/slack-fake.js');
  let state: typeof import('../state.js');
  let reminders: typeof import('./reminders.js');
  let watches: typeof import('./watches.js');
  let deliver: typeof import('./deliver.js');
  let retention: typeof import('../retention.js');

  const threads: string[] = [];
  async function newThread(prefix = 'C') {
    const channelId = `${prefix}SC${rand()}`;
    const threadTs = `17900${Math.floor(Math.random() * 1e5)}.000100`;
    const threadId = `${channelId}:${threadTs}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channelId}, ${threadTs}) on conflict do nothing`;
    threads.push(threadId);
    return { threadId, channelId, threadTs };
  }
  const ctxFor = (t: { threadId: string; channelId: string; threadTs: string }, speakerId: string) => ({
    role: 'front' as const,
    ...t,
    speakerId,
    turnId: Math.floor(Math.random() * 1e9),
    extras: {},
  });
  async function dueReminder(t: { threadId: string; channelId: string }, ownerId: string, text = 'check the release') {
    const [r] = await sql<{ id: number }[]>`
      insert into reminders (owner_id, thread_id, channel_id, text, due_at, tz, created_at)
      values (${ownerId}, ${t.threadId}, ${t.channelId}, ${text}, now() - interval '1 minute', 'Europe/Berlin', now() - interval '1 day')
      returning id::int as id`;
    return r!.id;
  }
  const reminderRow = async (id: number) => (await sql<any[]>`select * from reminders where id = ${id}`)[0];

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    ({ redis } = await import('../../core/redis.js'));
    fake = await import('../../core/slack-fake.js');
    const { migrate } = await import('../../db/migrate.js');
    await migrate();
    state = await import('../state.js');
    reminders = await import('./reminders.js');
    watches = await import('./watches.js');
    deliver = await import('./deliver.js');
    retention = await import('../retention.js');
    // Earlier runs' leftovers must not be fired by this run's pollers.
    await sql`update reminders set status = 'cancelled' where status in ('pending', 'firing')`;
    await sql`update watches set status = 'cancelled' where status = 'active'`;
  });

  afterAll(async () => {
    if (!sql) return;
    if (threads.length) await sql`delete from threads where id in ${sql(threads)}`;
    await sql.end();
    redis.disconnect();
  });

  beforeEach(async () => {
    await state.setPaused(false);
  });

  describe('reminder tools', () => {
    it('sets, lists and cancels; echoes the resolved time in the speaker zone', async () => {
      const t = await newThread();
      const owner = uid();
      const tools = reminders.reminderTools(ctxFor(t, owner));
      const exec = (tool: any, input: object) => tool.execute(input, { toolCallId: 'tc', messages: [] });
      const res: string = await exec(tools.set_reminder, { text: 'check the release', in: '2h' });
      expect(res).toMatch(/^Reminder set: r_\d+ for .*\(Europe\/Berlin\), in 2 hours/);
      const id = Number(/r_(\d+)/.exec(res)![1]);
      const row = await reminderRow(id);
      expect(row).toMatchObject({ ownerId: owner, threadId: t.threadId, channelId: t.channelId, status: 'pending', tz: 'Europe/Berlin' });
      expect(Math.abs(row.dueAt.getTime() - (Date.now() + 2 * 3600_000))).toBeLessThan(90_000);

      // Same call again (model retry) → same reminder.
      expect(await exec(tools.set_reminder, { text: 'check the release', in: '2h' })).toMatch(new RegExp(`^Already set: r_${id}`));

      const at: string = await exec(tools.set_reminder, { text: 'standup', at: '2026-12-01T09:00' });
      if (Date.now() < Date.parse('2026-12-01T08:00:00Z')) expect(at).toMatch(/Tue, 1 Dec 2026, 09:00 \(Europe\/Berlin\)/);

      const list: string = await exec(tools.list_reminders, {});
      expect(list).toContain(`r_${id}`);
      expect(list).toContain('"check the release"');

      expect(await exec(tools.cancel_reminder, { id: `r_${id}` })).toBe(`Cancelled r_${id}.`);
      expect((await reminderRow(id)).status).toBe('cancelled');
      expect(await exec(tools.cancel_reminder, { id: String(id) })).toMatch(/already cancelled/);
    });

    it('validates times', async () => {
      const t = await newThread();
      const tools = reminders.reminderTools(ctxFor(t, uid()));
      const exec = (tool: any, input: object) => tool.execute(input, { toolCallId: 'tc', messages: [] });
      expect(await exec(tools.set_reminder, { text: 'x', at: '2020-01-01T09:00Z' })).toMatch(/past/);
      expect(await exec(tools.set_reminder, { text: 'x', in: '2 years' })).toMatch(/duration/);
      expect(await exec(tools.set_reminder, { text: 'x', in: '400 days' })).toMatch(/too far/);
      expect(await exec(tools.set_reminder, { text: 'x' })).toMatch(/`at`.*`in`/);
    });

    it('is owner-only and hides texts from other conversations outside DMs', async () => {
      const t = await newThread();
      const other = await newThread();
      const owner = uid();
      const intruder = uid();
      const exec = (tool: any, input: object) => tool.execute(input, { toolCallId: 'tc', messages: [] });
      const res: string = await exec(reminders.reminderTools(ctxFor(other, owner)).set_reminder, { text: 'secret dentist thing', in: '1 day' });
      const id = Number(/r_(\d+)/.exec(res)![1]);

      const theirs = reminders.reminderTools(ctxFor(t, intruder));
      expect(await exec(theirs.cancel_reminder, { id: `r_${id}` })).toMatch(/has no reminder/);
      expect(await exec(theirs.list_reminders, {})).toMatch(/no pending reminders/);
      expect((await reminderRow(id)).status).toBe('pending');

      // The owner in a different channel: listed, text hidden.
      const elsewhere: string = await exec(reminders.reminderTools(ctxFor(t, owner)).list_reminders, {});
      expect(elsewhere).toContain(`r_${id}`);
      expect(elsewhere).not.toContain('dentist');
      // In a DM: shown.
      const dm: string = await exec(reminders.reminderTools(ctxFor({ threadId: `D${rand()}:1.1`, channelId: `D${rand()}`, threadTs: '1.1' }, owner)).list_reminders, {});
      expect(dm).toContain('dentist');
      await sql`update reminders set status = 'cancelled' where id = ${id}`;
    });

    it('caps pending reminders per user', async () => {
      const t = await newThread();
      const owner = uid();
      const { limits } = await import('../../config.js');
      for (let i = 0; i < limits.userPendingReminders; i++)
        await sql`insert into reminders (owner_id, thread_id, channel_id, text, due_at) values (${owner}, ${t.threadId}, ${t.channelId}, ${`r${i}`}, now() + interval '1 day')`;
      const res = await reminders.setReminder(ctxFor(t, owner), { text: 'one more', in: '1h' });
      expect(res).toMatch(/Limit reached/);
      await sql`update reminders set status = 'cancelled' where owner_id = ${owner}`;
    });
  });

  describe('firing', () => {
    it('fires each due reminder exactly once under concurrent pollers', async () => {
      const owner = uid();
      const ids: number[] = [];
      const ts: { threadId: string }[] = [];
      for (let i = 0; i < 8; i++) {
        const t = await newThread();
        ts.push(t);
        ids.push(await dueReminder(t, owner, `task ${i}`));
      }
      const fired = await Promise.all([1, 2, 3, 4].map(() => reminders.fireDueReminders()));
      expect(fired.reduce((a, b) => a + b, 0)).toBe(8);
      const rows = await sql<any[]>`select * from reminders where id in ${sql(ids)}`;
      expect(rows.every((r) => r.status === 'fired' && r.turnId)).toBe(true);
      const turns = await sql<any[]>`
        select t.id::int as id, t.thread_id, t.author_id, t.kind, t.is_mention, t.status, i.source, i.source_id::int as source_id, i.input
        from turns t join scheduled_turn_inputs i on i.turn_id = t.id where i.source = 'reminder' and i.source_id in ${sql(ids)}`;
      expect(turns).toHaveLength(8);
      for (const turn of turns) {
        const r = rows.find((x) => Number(x.id) === turn.sourceId);
        expect(turn).toMatchObject({ threadId: r.threadId, authorId: owner, kind: 'scheduled', isMention: true, status: 'pending' });
        expect(Number(r.turnId)).toBe(turn.id);
        expect(turn.input).toContain(r.text);
        expect(turn.input).toContain(`<@${owner}>`);
      }
      const [thread] = await sql<any[]>`select engaged from threads where id = ${ts[0]!.threadId}`;
      expect(thread.engaged).toBe(true);
      // Nothing left to fire.
      expect(await reminders.fireDueReminders()).toBe(0);
      expect(await deliver.scheduledTurnInput(turns[0]!.id)).toMatchObject({ source: 'reminder' });
    });

    it('a stale claim cannot fire; an expired lease is retried', async () => {
      const t = await newThread();
      const owner = uid();
      const id = await dueReminder(t, owner);
      const first = await reminders.claimDueReminder();
      expect(first?.id).toBe(id);
      // Lease runs out (crashed poller) → another poller re-claims it.
      await sql`update reminders set claimed_until = now() - interval '1 second' where id = ${id}`;
      const second = await reminders.claimDueReminder();
      expect(second?.id).toBe(id);
      expect(second?.attempts).toBe(2);
      expect(await reminders.fireReminder(first!)).toBe('lost');
      expect(await reminders.fireReminder(second!)).toBe('fired');
      const [{ n }] = await sql<any[]>`select count(*)::int as n from scheduled_turn_inputs where source = 'reminder' and source_id = ${id}`;
      expect(n).toBe(1);
    });

    it('gives up after too many attempts', async () => {
      const t = await newThread();
      const id = await dueReminder(t, uid());
      await sql`update reminders set attempts = ${reminders.MAX_FIRE_ATTEMPTS} where id = ${id}`;
      const r = await reminders.claimDueReminder();
      expect(await reminders.fireReminder(r!)).toBe('failed');
      expect(await reminderRow(id)).toMatchObject({ status: 'failed', skipReason: 'too_many_attempts' });
    });

    it('skips quietly when entry rules block it', async () => {
      const cases: [string, (t: { channelId: string }, owner: string) => Promise<() => void | Promise<void>>][] = [
        ['paused', async () => (await state.setPaused(true), () => state.setPaused(false))],
        ['channel_disabled', async (t) => (await state.setChannelDisabled(t.channelId, true), () => state.setChannelDisabled(t.channelId, false))],
        ['suspended', async (_t, owner) => (await state.setBlock(owner, { suspended: true }), () => state.setBlock(owner, { suspended: false }))],
        [
          'bot_removed',
          async (t) =>
            fake.addFakeHandler((m, a) => (m === 'conversations.info' && a.channel === t.channelId ? { ok: true, channel: { id: t.channelId, is_member: false } } : undefined)),
        ],
        [
          'channel_archived',
          async (t) =>
            fake.addFakeHandler((m, a) => (m === 'conversations.info' && a.channel === t.channelId ? { ok: true, channel: { id: t.channelId, is_member: true, is_archived: true } } : undefined)),
        ],
      ];
      for (const [reason, setup] of cases) {
        const t = await newThread();
        const owner = uid();
        const id = await dueReminder(t, owner);
        const undo = await setup(t, owner);
        try {
          const r = await reminders.claimDueReminder();
          expect(r?.id).toBe(id);
          expect(await reminders.fireReminder(r!)).toBe('skipped');
        } finally {
          await undo();
        }
        expect(await reminderRow(id)).toMatchObject({ status: 'skipped', skipReason: reason, turnId: null });
      }
    });

    it('falls back to a DM thread when the original thread root was deleted (idempotent post)', async () => {
      const t = await newThread();
      const owner = uid();
      const id = await dueReminder(t, owner);
      await sql`update threads set root_deleted_at = now() where id = ${t.threadId}`;
      const n = (await fake.fakeCalls()).length;
      expect(await reminders.fireDueReminders()).toBe(1);
      const row = await reminderRow(id);
      expect(row.status).toBe('fired');
      expect(row.firedThreadId).toMatch(new RegExp(`^D${owner}:`));
      threads.push(row.firedThreadId);
      const calls = (await fake.fakeCalls()).slice(n);
      const root = calls.find((c) => c.method === 'chat.postMessage');
      expect(root?.args).toMatchObject({ channel: `D${owner}` });
      expect(root?.args.thread_ts).toBeUndefined();
      const [turn] = await sql<any[]>`select thread_id, author_id from turns where id = ${row.turnId}`;
      expect(turn).toMatchObject({ threadId: row.firedThreadId, authorId: owner });
      const [th] = await sql<any[]>`select is_dm from threads where id = ${row.firedThreadId}`;
      expect(th.isDm).toBe(true);
      // A retried resolve reuses the same DM root.
      const again = await deliver.resolveTarget({ ownerId: owner, threadId: t.threadId, idempotencyKey: `reminder-dm:${id}`, rootText: 'x' });
      expect(again.threadId).toBe(row.firedThreadId);
    });

    it('recreates a thread row removed by retention', async () => {
      const t = await newThread();
      const owner = uid();
      const id = await dueReminder(t, owner);
      await sql`delete from threads where id = ${t.threadId}`;
      expect(await reminders.fireDueReminders()).toBe(1);
      const row = await reminderRow(id);
      expect(row).toMatchObject({ status: 'fired', firedThreadId: t.threadId });
      expect((await sql`select 1 from threads where id = ${t.threadId}`).length).toBe(1);
    });
  });

  describe('watches', () => {
    type Page = { text: string; status?: number };
    function makeDeps(o: { page?: () => Page; web?: () => string[]; slack?: () => any[]; judge?: (f: string) => boolean } = {}) {
      const judged: string[] = [];
      const deps: import('./watches.js').WatchDeps = {
        fetchPage: async (url) => {
          const p = o.page?.() ?? { text: 'Deadline: Oct 10' };
          return { url, status: p.status ?? 200, contentType: 'text/html', title: 'T', text: p.text, bytesTruncated: false };
        },
        webSearch: async (_ctx, query) => {
          const urls = o.web?.() ?? [];
          return { text: `Web results for "${query}":\n\n${urls.map((u, i) => `${i + 1}. R${i}\n   ${u}\n   > snippet ${i}`).join('\n\n')}`, sources: urls.map((url) => ({ url })) };
        },
        slackSearch: async () => o.slack?.() ?? [],
        judge: async ({ findings }) => {
          judged.push(findings);
          return { meaningful: o.judge ? o.judge(findings) : true, summary: 'it changed' };
        },
      };
      return { deps, judged };
    }
    const due = (id: number) => sql`update watches set next_check_at = now() - interval '1 second' where id = ${id}`;
    const watchRow = async (id: number) => (await sql<any[]>`select * from watches where id = ${id}`)[0];
    async function checkNow(id: number, deps: import('./watches.js').WatchDeps) {
      await due(id);
      const w = await watches.claimDueWatch();
      expect(w?.id).toBe(id);
      return watches.checkWatch(w!, deps);
    }

    it('url watch: baseline, unchanged, not meaningful, then notifies once with the diff', async () => {
      const t = await newThread();
      const owner = uid();
      let text = 'YSWS\nDeadline: Oct 10\nFooter';
      let meaningful = false;
      const { deps, judged } = makeDeps({ page: () => ({ text }), judge: () => meaningful });
      const res = await watches.createWatch(ctxFor(t, owner), { source: 'url', target: 'https://ysws.example.com/#top', criteria: 'deadline changes' }, deps);
      expect(res).toMatch(/^Watch w_\d+ created: .*every 6 hours.*expires .*after 30 days/);
      const id = Number(/w_(\d+)/.exec(res)![1]);
      const row = await watchRow(id);
      expect(row).toMatchObject({ target: 'https://ysws.example.com/', intervalS: 6 * 3600, status: 'active' });
      expect(row.state.text).toBe(text);

      expect(await checkNow(id, deps)).toBe('unchanged');
      expect(judged).toHaveLength(0);

      text = 'YSWS\nDeadline: Oct 10\nFooter v2';
      expect(await checkNow(id, deps)).toBe('not_meaningful');
      expect((await watchRow(id)).state.text).toBe(text); // baseline moved

      text = 'YSWS\nDeadline: Oct 17\nFooter v2';
      meaningful = true;
      expect(await checkNow(id, deps)).toBe('notified');
      expect(judged.at(-1)).toContain('+ Deadline: Oct 17');
      expect(judged.at(-1)).toContain('- Deadline: Oct 10');
      const notes = await sql<any[]>`select * from watch_notifications where watch_id = ${id}`;
      expect(notes).toHaveLength(1);
      const [turn] = await sql<any[]>`
        select t.thread_id, t.author_id, t.kind, t.is_mention, i.input from turns t join scheduled_turn_inputs i on i.turn_id = t.id where t.id = ${notes[0].turnId}`;
      expect(turn).toMatchObject({ threadId: t.threadId, authorId: owner, kind: 'scheduled', isMention: false });
      expect(turn.input).toContain('<untrusted_content');
      expect(turn.input).toContain('Deadline: Oct 17');
      expect(turn.input).toContain('deadline changes');
    });

    it('notification is created at most once per check', async () => {
      const t = await newThread();
      const owner = uid();
      let n = 0;
      const { deps } = makeDeps({ web: () => [`https://r.dev/${n++}`] });
      const res = await watches.createWatch(ctxFor(t, owner), { source: 'web_search', target: 'ysws news', criteria: 'new programs' }, deps);
      const id = Number(/w_(\d+)/.exec(res)![1]);
      await due(id);
      const w = (await watches.claimDueWatch())!;
      const results = await Promise.all([watches.checkWatch(w, deps), watches.checkWatch(w, deps)]);
      expect(results.sort()).toEqual(['lost', 'notified']);
      const [{ c }] = await sql<any[]>`select count(*)::int as c from watch_notifications where watch_id = ${id}`;
      expect(c).toBe(1);
    });

    it('web_search watch reports only new URLs; daily cap holds the baseline', async () => {
      const t = await newThread();
      const owner = uid();
      let urls = ['https://a.dev', 'https://b.dev'];
      const { deps, judged } = makeDeps({ web: () => urls });
      const id = Number(/w_(\d+)/.exec(await watches.createWatch(ctxFor(t, owner), { source: 'web_search', target: 'q', criteria: 'anything new', check_every_hours: 0.5 }, deps))![1]);
      expect((await watchRow(id)).intervalS).toBe(3600); // clamped to the 1h minimum
      expect(await checkNow(id, deps)).toBe('unchanged');
      urls = ['https://c.dev', 'https://a.dev'];
      expect(await checkNow(id, deps)).toBe('notified');
      expect(judged.at(-1)).toContain('https://c.dev');
      expect(judged.at(-1)).not.toContain('https://a.dev');

      const { limits } = await import('../../config.js');
      for (let i = 0; i < limits.watchNotificationsPerDay; i++) await sql`insert into watch_notifications (watch_id, check_no) values (${id}, ${1000 + i})`;
      urls = ['https://d.dev'];
      expect(await checkNow(id, deps)).toBe('daily_cap');
      expect((await watchRow(id)).state.seen).not.toContain('https://d.dev');
    });

    it('slack_search watch: only newer matches from others', async () => {
      const t = await newThread();
      const owner = uid();
      let matches: any[] = [];
      const { deps, judged } = makeDeps({ slack: () => matches });
      const id = Number(/w_(\d+)/.exec(await watches.createWatch(ctxFor(t, owner), { source: 'slack_search', target: 'onboard-x', criteria: 'anyone mentions it' }, deps))![1]);
      const since = Number((await watchRow(id)).state.sinceTs);
      const ts = (d: number) => (since + d).toFixed(6);
      matches = [
        { ts: ts(-100), user: 'UOLD', text: 'old onboard-x', channel: { id: 'CPUB', name: 'pub' }, permalink: 'https://x/p1' },
        { ts: ts(10), user: owner, text: 'my own onboard-x', channel: { id: 'CPUB', name: 'pub' }, permalink: 'https://x/p2' },
      ];
      expect(await checkNow(id, deps)).toBe('unchanged');
      matches.push({ ts: ts(20), user: 'UNEW', text: 'onboard-x is cool', channel: { id: 'CPUB', name: 'pub' }, permalink: 'https://x/p3' });
      expect(await checkNow(id, deps)).toBe('notified');
      expect(judged.at(-1)).toContain('onboard-x is cool');
      expect(judged.at(-1)).not.toContain('old onboard-x');
      expect(judged.at(-1)).not.toContain('my own');
      expect((await watchRow(id)).state.sinceTs).toBe(ts(20));
    });

    it('caps, owner-only cancel, entry checks and expiry', async () => {
      const t = await newThread();
      const owner = uid();
      const { deps } = makeDeps();
      const { limits } = await import('../../config.js');
      const ids: number[] = [];
      for (let i = 0; i < limits.userActiveWatches; i++)
        ids.push(Number(/w_(\d+)/.exec(await watches.createWatch(ctxFor(t, owner), { source: 'url', target: `https://e${i}.dev`, criteria: 'x' }, deps))![1]));
      expect(await watches.createWatch(ctxFor(t, owner), { source: 'url', target: 'https://more.dev', criteria: 'x' }, deps)).toMatch(/Limit reached/);
      expect(await watches.createWatch(ctxFor(t, uid()), { source: 'url', target: 'ftp://x', criteria: 'x' }, deps)).toMatch(/not an http/);

      expect(await watches.cancelWatch(ctxFor(t, uid()), `w_${ids[0]}`)).toMatch(/has no watch/);
      expect(await watches.listWatches(ctxFor(t, owner))).toContain(`w_${ids[0]}`);
      expect(await watches.cancelWatch(ctxFor(t, owner), `w_${ids[0]}`)).toBe(`Cancelled w_${ids[0]}.`);
      expect(await watchRow(ids[0]!)).toMatchObject({ status: 'cancelled', state: {} });

      await state.setPaused(true);
      try {
        expect(await checkNow(ids[1]!, deps)).toBe('skipped: paused');
      } finally {
        await state.setPaused(false);
      }

      await sql`update watches set expires_at = now() - interval '1 second' where id = ${ids[2]!}`;
      expect(await watches.expireWatches()).toBeGreaterThanOrEqual(1);
      expect(await watchRow(ids[2]!)).toMatchObject({ status: 'expired', state: {} });
      await sql`update watches set status = 'cancelled' where id in ${sql(ids)}`;
    });

    it('expires_in_days is capped at 30', () => {
      const { lifetimeMs, intervalMs } = watches.watchTiming({ expires_in_days: 90, check_every_hours: 2 });
      expect(lifetimeMs).toBe(30 * 86400_000);
      expect(intervalMs).toBe(2 * 3600_000);
    });
  });

  it('App Home lists own items and cancel buttons only touch the clicker\'s own', async () => {
    const t = await newThread();
    const owner = uid();
    const home = await import('./home.js');
    const res = await reminders.setReminder(ctxFor(t, owner), { text: 'water plants', in: '3h' });
    const id = Number(/r_(\d+)/.exec(res)![1]);
    const blocks = JSON.stringify(await home.scheduleHomeBlocks(owner));
    expect(blocks).toContain('water plants');
    expect(blocks).toContain('sched:cancel_reminder');
    expect(await home.scheduleHomeBlocks(uid())).toEqual([]);
    const published: string[] = [];
    const click = (userId: string) =>
      home.handleScheduleAction({ userId, actionId: 'sched:cancel_reminder', value: String(id), body: {} } as any, async (u) => void published.push(u));
    const intruder = uid();
    await click(intruder);
    expect((await reminderRow(id)).status).toBe('pending');
    await click(owner);
    expect((await reminderRow(id)).status).toBe('cancelled');
    expect(published).toEqual([intruder, owner]);
  });

  it('retention deletes finished reminders and ended watches after the window', async () => {
    const t = await newThread();
    const owner = uid();
    const [old] = await sql<any[]>`
      insert into reminders (owner_id, thread_id, channel_id, text, due_at, status, fired_at)
      values (${owner}, ${t.threadId}, ${t.channelId}, 'x', now() - interval '40 days', 'fired', now() - interval '40 days') returning id`;
    const [recent] = await sql<any[]>`
      insert into reminders (owner_id, thread_id, channel_id, text, due_at, status, updated_at)
      values (${owner}, ${t.threadId}, ${t.channelId}, 'y', now() - interval '1 day', 'cancelled', now() - interval '1 day') returning id`;
    const [pending] = await sql<any[]>`
      insert into reminders (owner_id, thread_id, channel_id, text, due_at, created_at, updated_at)
      values (${owner}, ${t.threadId}, ${t.channelId}, 'z', now() + interval '100 days', now() - interval '60 days', now() - interval '60 days') returning id`;
    const [w] = await sql<any[]>`
      insert into watches (owner_id, thread_id, channel_id, source, target, criteria, interval_s, status, next_check_at, expires_at, ended_at)
      values (${owner}, ${t.threadId}, ${t.channelId}, 'url', 'https://x.dev', 'c', 3600, 'expired', now(), now() - interval '40 days', now() - interval '40 days') returning id`;
    await retention.runRetention();
    const left = (await sql<any[]>`select id from reminders where id in ${sql([old.id, recent.id, pending.id])}`).map((r) => r.id);
    expect(left.sort()).toEqual([recent.id, pending.id].sort());
    expect((await sql`select 1 from watches where id = ${w.id}`).length).toBe(0);
    await sql`update reminders set status = 'cancelled' where id = ${pending.id}`;
  });
});
