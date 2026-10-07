/**
 * Code sandboxes against the test Postgres/Redis, the fake Slack and a fake provider (no Modal, no Cloudflare, no
 * model calls): tool gating, one sandbox for parallel calls, idle pause → resume with files, lost sandboxes, the
 * sweep destroying ended subagents, orphan reconcile, import/export through the file store and its access rule,
 * budget and quota refusals, HCA caching, and the whole preview flow (terms, deploy, claim, report, expiry).
 *   INTEGRATION=1 pnpm vitest run src/sandbox/sandbox.int.test.ts
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // The feature on (the provider is replaced by a fake below), previews on.
  process.env.MODAL_TOKEN_ID ||= 'fake-id';
  process.env.MODAL_TOKEN_SECRET ||= 'fake-secret';
  process.env.PREVIEW_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.SANDBOX_MONTHLY_BUDGET_USD = '1000';
  process.env.SANDBOX_WORKSPACE_CREDIT_USD = '1000';
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('code sandboxes', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let toolsFor: typeof import('../core/tools.js').toolsFor;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  let L: typeof import('./lifecycle.js');
  let B: typeof import('./budget.js');
  let H: typeof import('./hca.js');
  let A: typeof import('./access.js');
  let F: typeof import('./preview/flow.js');
  let PS: typeof import('./preview/store.js');
  let D: typeof import('./preview/deploy.js');
  let hooks: typeof import('./hooks.js');
  let files: typeof import('../files/store.js');
  let FakeProvider: typeof import('./fake-provider.js').FakeProvider;
  let fake: InstanceType<typeof import('./fake-provider.js').FakeProvider>;
  const CH = `CSBX${rand()}`;
  const threads: string[] = [];
  const users: string[] = [];
  const newThread = async () => {
    const ts = `1790${Math.floor(Math.random() * 1e6)}.000100`;
    const id = `${CH}:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${id}, ${CH}, ${ts}) on conflict do nothing`;
    threads.push(id);
    return id;
  };
  const newUser = async (allow = true) => {
    const u = `USBX${rand()}`;
    users.push(u);
    if (allow) await sql`insert into sandbox_allowlist (user_id, added_by) values (${u}, 'test')`;
    return u;
  };
  /** A subagent with a running run (what a sandbox tool call sees). */
  const newSubagent = async (o: { threadId: string; owner: string; sandbox?: boolean }) => {
    const id = `sa_${rand().toLowerCase()}`;
    await sql`insert into subagents (id, thread_id, owner_id, title, status, sandbox) values (${id}, ${o.threadId}, ${o.owner}, 'Test', 'running', ${o.sandbox ?? true})`;
    const [r] = await sql<{ id: number }[]>`insert into runs (subagent_id, thread_id, instructions, status) values (${id}, ${o.threadId}, 'x', 'running') returning id`;
    return { subagentId: id, runId: Number(r!.id) };
  };
  const ctxOf = (threadId: string, owner: string, sa: { subagentId: string; runId: number }) => {
    const [channelId, threadTs] = threadId.split(':') as [string, string];
    return { threadId, channelId, threadTs, speakerId: owner, subagentId: sa.subagentId, runId: sa.runId, extras: {} };
  };
  const call = (ctx: any, name: string, input: object) => (toolsFor('child', ctx)[name] as any).execute(input, { toolCallId: `tc${rand()}`, messages: [] });
  const finishRun = async (runId: number, status = 'complete') => {
    await sql`update runs set status = ${status}, finished_at = now() where id = ${runId}`;
    await sql`update subagents set status = 'idle' where id = (select subagent_id from runs where id = ${runId})`;
  };
  const callsSince = async (n: number) => (await fakeCalls()).slice(n);

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    ({ toolsFor } = await import('../core/tools.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    ({ FakeProvider } = await import('./fake-provider.js'));
    const { setSandboxProvider } = await import('./providers.js');
    fake = new FakeProvider();
    setSandboxProvider(fake);
    await import('../tools/index.js');
    L = await import('./lifecycle.js');
    B = await import('./budget.js');
    H = await import('./hca.js');
    A = await import('./access.js');
    F = await import('./preview/flow.js');
    PS = await import('./preview/store.js');
    D = await import('./preview/deploy.js');
    hooks = await import('./hooks.js');
    files = await import('../files/store.js');
  });

  beforeEach(async () => {
    fake.onExec = (cmd) => ({ stdout: `ran: ${cmd}\n` });
    // Live sandboxes count against the per-user and global caps: end the previous tests' ones.
    if (threads.length) await sql`update sandboxes set state = 'destroyed' where thread_id in ${sql(threads)} and state <> 'destroyed'`;
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    for (const t of threads) {
      await sql`delete from sandboxes where thread_id = ${t}`;
      await sql`delete from previews where thread_id = ${t}`;
      await sql`delete from files where thread_id = ${t}`;
      await sql`delete from sandbox_usage where thread_id = ${t}`;
      await sql`delete from threads where id = ${t}`;
    }
    for (const u of users) {
      await sql`delete from sandbox_allowlist where user_id = ${u}`;
      await sql`delete from hca_verifications where user_id = ${u}`;
      await sql`delete from preview_terms where user_id = ${u}`;
      await sql`delete from sandbox_first_use where user_id = ${u}`;
    }
    const { closeQueues, queue, QUEUE } = await import('../core/queues.js');
    await queue(QUEUE.sandbox).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await sql.end();
    redis.disconnect();
  });

  it('refuses the tools for subagents without the flag, and for users without access', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u, sandbox: false });
    expect(await call(ctxOf(t, u, sa), 'sandbox_exec', { command: 'ls' })).toMatch(/only available to subagents started with sandbox: true/);
    const stranger = await newUser(false);
    const sa2 = await newSubagent({ threadId: t, owner: stranger });
    const prev = H.hcaClient.check;
    H.hcaClient.check = async () => 'unverified';
    try {
      const n = (await fakeCalls()).length;
      const out = await call(ctxOf(t, stranger, sa2), 'sandbox_exec', { command: 'ls' });
      expect(out).toMatch(/told why privately/);
      expect(out).not.toMatch(/verif/i);
      await vi.waitFor(async () => {
        const eph = (await callsSince(n)).filter((c) => c.method === 'chat.postEphemeral');
        expect(eph).toHaveLength(1);
        expect(eph[0]!.args.user).toBe(stranger);
        expect(eph[0]!.args.text).toMatch(/auth\.hackclub\.com/);
      });
      // At most one explanation per cooldown.
      await call(ctxOf(t, stranger, sa2), 'sandbox_exec', { command: 'ls' });
      await new Promise((r) => setTimeout(r, 200));
      expect((await callsSince(n)).filter((c) => c.method === 'chat.postEphemeral')).toHaveLength(1);
    } finally {
      H.hcaClient.check = prev;
    }
    expect(fake.counts.create).toBe(0);
  });

  it('creates one sandbox for parallel calls, lazily, and runs commands', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u });
    const ctx = ctxOf(t, u, sa);
    fake.createDelayMs = 100;
    const before = fake.counts.create;
    const outs = await Promise.all([1, 2, 3].map((i) => call(ctx, 'sandbox_exec', { command: `echo ${i}` })));
    fake.createDelayMs = 0;
    expect(fake.counts.create - before).toBe(1);
    // The one-time first-use note went to the owner only, once.
    await vi.waitFor(async () => {
      const notes = (await fakeCalls()).filter((c) => c.method === 'chat.postEphemeral' && c.args.user === u && /Modal \(US\)/.test(c.args.text));
      expect(notes).toHaveLength(1);
    });
    for (const [i, o] of outs.entries()) expect(o).toContain(`ran: echo ${i + 1}`);
    expect(outs[0]).toMatch(/untrusted_content/);
    const [row] = await sql<any[]>`select * from sandboxes where subagent_id = ${sa.subagentId}`;
    expect(row.state).toBe('running');
    const [ev] = await sql<any[]>`select payload from thread_events where thread_id = ${t} and type = 'sandbox_exec' limit 1`;
    expect(ev.payload.command).toMatch(/^echo \d$/);
    expect(JSON.stringify(ev.payload)).not.toContain('ran:');
    // A usage segment is open.
    const [seg] = await sql<any[]>`select * from sandbox_usage where sandbox_id = ${row.id} and ended_at is null`;
    expect(seg.userId).toBe(u);
  });

  it('writes and reads files; refuses paths outside /work', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u });
    const ctx = ctxOf(t, u, sa);
    expect(await call(ctx, 'sandbox_write_file', { path: 'notes/a.txt', content: 'hello sandbox' })).toMatch(/Wrote \/work\/notes\/a\.txt/);
    expect(await call(ctx, 'sandbox_read_file', { path: '/work/notes/a.txt' })).toContain('hello sandbox');
    expect(await call(ctx, 'sandbox_write_file', { path: '../etc/x', content: 'x' })).toMatch(/Bad path/);
    expect(await call(ctx, 'sandbox_read_file', { path: '/etc/passwd' })).toMatch(/Bad path/);
    expect(await call(ctx, 'sandbox_write_file', { path: 'big.txt', content: 'x'.repeat(300 * 1024) })).toMatch(/Too large/);
  });

  it('pauses when idle and resumes with the files; a lost sandbox is replaced with a note', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u });
    const ctx = ctxOf(t, u, sa);
    await call(ctx, 'sandbox_write_file', { path: 'keep.txt', content: 'still here' });
    await finishRun(sa.runId);
    await hooks.onSandboxRunFinished(sa.runId);
    const [row] = await sql<any[]>`select * from sandboxes where subagent_id = ${sa.subagentId}`;
    expect(row.idleSince).toBeTruthy();
    await sql`update sandboxes set idle_since = now() - interval '1 hour' where id = ${row.id}`;
    const swept = await L.sweepSandboxes();
    expect(swept.paused).toBeGreaterThanOrEqual(1);
    expect(await L.pauseSandbox(row.id, { generation: row.generation })).toBe('paused');
    const [paused] = await sql<any[]>`select * from sandboxes where id = ${row.id}`;
    expect(paused.state).toBe('paused');
    expect(paused.providerId).toBeNull();
    expect((await sql`select 1 from sandbox_usage where sandbox_id = ${row.id} and ended_at is null`).length).toBe(0);
    // A follow-up run resumes it.
    const [r2] = await sql<{ id: number }[]>`insert into runs (subagent_id, thread_id, instructions, status, is_resume) values (${sa.subagentId}, ${t}, 'more', 'running', true) returning id`;
    const ctx2 = { ...ctx, runId: Number(r2!.id) };
    const resumes = fake.counts.resume;
    expect(await call(ctx2, 'sandbox_read_file', { path: 'keep.txt' })).toContain('still here');
    expect(fake.counts.resume - resumes).toBe(1);
    // The snapshot it resumed from is deleted.
    await vi.waitFor(() => expect(fake.snapshots.has(paused.pausedRef)).toBe(false));
    // A stale pause job (old generation) is a no-op.
    expect(await L.pauseSandbox(row.id, { generation: row.generation })).toBe('skipped');
    // Provider kill: the next call runs in a fresh sandbox and says files were lost.
    const [live] = await sql<any[]>`select provider_id from sandboxes where id = ${row.id}`;
    fake.kill(live.providerId);
    const out = await call(ctx2, 'sandbox_exec', { command: 'ls' });
    expect(out).toMatch(/files from before are gone/);
    expect(out).toContain('ran: ls');
  });

  it('destroys sandboxes of ended subagents and reconciles orphans', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u });
    await call(ctxOf(t, u, sa), 'sandbox_exec', { command: 'true' });
    const [row] = await sql<any[]>`select * from sandboxes where subagent_id = ${sa.subagentId}`;
    await sql`update runs set status = 'cancelled' where id = ${sa.runId}`;
    await sql`update subagents set status = 'cancelled' where id = ${sa.subagentId}`;
    const swept = await L.sweepSandboxes();
    expect(swept.destroyed).toBeGreaterThanOrEqual(1);
    await L.destroySandbox(row.id);
    const [after] = await sql<any[]>`select * from sandboxes where id = ${row.id}`;
    expect(after.state).toBe('destroyed');
    expect(fake.boxes.get(row.providerId)!.alive).toBe(false);
    // Orphan: a live provider sandbox with our tags and no row.
    const { baseTags } = await import('./providers.js');
    const orphan = await fake.create({ ...L.workSpec('sbx_orphan'), tags: { ...baseTags(), kind: 'work', sbx: 'sbx_orphan' } });
    const r = await L.reconcileSandboxes();
    expect(r.orphans).toBeGreaterThanOrEqual(1);
    expect(fake.boxes.get(orphan.providerId)!.alive).toBe(false);
  });

  it('reconcile leaves a sandbox mid-pause alone; the pause completes', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u });
    await call(ctxOf(t, u, sa), 'sandbox_write_file', { path: 'keep.txt', content: 'x' });
    await finishRun(sa.runId);
    const [row] = await sql<any[]>`select * from sandboxes where subagent_id = ${sa.subagentId}`;
    fake.pauseDelayMs = 400;
    try {
      const pausing = L.pauseSandbox(row.id, { generation: row.generation });
      await vi.waitFor(async () => expect((await sql<any[]>`select state from sandboxes where id = ${row.id}`)[0].state).toBe('pausing'));
      // The pause holds the lock: skipped. And with an old updated_at, the state alone protects it.
      await sql`update sandboxes set updated_at = now() - interval '1 hour' where id = ${row.id}`;
      await L.reconcileSandboxes();
      expect(fake.boxes.get(row.providerId)!.alive).toBe(true);
      expect(await pausing).toBe('paused');
    } finally {
      fake.pauseDelayMs = 0;
    }
    const [after] = await sql<any[]>`select * from sandboxes where id = ${row.id}`;
    expect(after.state).toBe('paused');
    expect(fake.snapshots.has(after.pausedRef)).toBe(true);
    // State-based protection without the lock: a 'pausing' row whose box is still listed is not an orphan.
    const sa2 = await newSubagent({ threadId: t, owner: u });
    await call(ctxOf(t, u, sa2), 'sandbox_exec', { command: 'true' });
    const [r2] = await sql<any[]>`select * from sandboxes where subagent_id = ${sa2.subagentId}`;
    await sql`update sandboxes set state = 'pausing', updated_at = now() - interval '5 minutes' where id = ${r2.id}`;
    await L.reconcileSandboxes();
    expect(fake.boxes.get(r2.providerId)!.alive).toBe(true);
    // Stuck for long → lost (and then its box is an orphan once the grace period has passed).
    await sql`update sandboxes set updated_at = now() - interval '1 hour' where id = ${r2.id}`;
    const r = await L.reconcileSandboxes();
    expect(r.lost).toBeGreaterThanOrEqual(1);
    expect((await sql<any[]>`select state from sandboxes where id = ${r2.id}`)[0].state).toBe('lost');
    // Still listed but the row just changed (grace): kept; after the grace period: destroyed.
    expect(fake.boxes.get(r2.providerId)!.alive).toBe(true);
    await sql`update sandboxes set updated_at = now() - interval '1 hour' where id = ${r2.id}`;
    await L.reconcileSandboxes();
    expect(fake.boxes.get(r2.providerId)!.alive).toBe(false);
  });

  it('imports thread files (access rule applies) and exports deliverables into the file store', async () => {
    const tA = await newThread();
    const tB = await newThread();
    const u = await newUser();
    const other = await newUser();
    const upload = await files.createFile({ threadId: tA, ownerId: other, name: 'data.csv', content: Buffer.from('a,b\n1,2\n'), description: 'data' });
    const saA = await newSubagent({ threadId: tA, owner: u });
    const saB = await newSubagent({ threadId: tB, owner: u });
    expect(await call(ctxOf(tA, u, saA), 'sandbox_import', { file_id: upload.id })).toMatch(/to \/work\/in\/data\.csv/);
    expect(await call(ctxOf(tA, u, saA), 'sandbox_read_file', { path: 'in/data.csv' })).toContain('a,b');
    expect(await call(ctxOf(tB, u, saB), 'sandbox_import', { file_id: upload.id })).toMatch(/No file .* is available here/);
    // Export: a 6 MB file is fine for sandbox exports (the general 5 MB cap is scoped), and it's idempotent.
    const big = randomBytes(6 * 1024 * 1024);
    const [row] = await sql<any[]>`select provider_id from sandboxes where subagent_id = ${saA.subagentId}`;
    fake.boxes.get(row.providerId)!.files.set('/work/out/big.bin', big);
    const e1 = await call(ctxOf(tA, u, saA), 'sandbox_export', { path: 'out/big.bin', description: 'random bytes' });
    const e2 = await call(ctxOf(tA, u, saA), 'sandbox_export', { path: 'out/big.bin', description: 'random bytes' });
    const id = /file_[a-z0-9]{10}/.exec(e1)![0];
    expect(e2).toContain(id);
    const listed = await files.filesCreatedByRuns([saA.runId]);
    expect(listed.get(saA.runId)!.map((f) => f.id)).toContain(id);
    fake.boxes.get(row.providerId)!.files.set('/work/out/huge.bin', Buffer.alloc(26 * 1024 * 1024));
    expect(await call(ctxOf(tA, u, saA), 'sandbox_export', { path: 'out/huge.bin', description: 'x' })).toMatch(/limited to 25/);
  });

  it('budget: exhausted → refused for everyone, running sandboxes paused; last month does not count', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u });
    await call(ctxOf(t, u, sa), 'sandbox_exec', { command: 'true' });
    const lastMonth = new Date(B.monthStart(new Date()).getTime() - 86_400_000);
    await sql`insert into sandbox_usage (user_id, thread_id, cpu, memory_mib, started_at, ended_at, est_usd) values (${u}, ${t}, 1, 1024, ${lastMonth}, ${lastMonth}, 5000)`;
    B.invalidateBudget();
    expect((await B.budgetStatus()).exhausted).toBe(false);
    await sql`insert into sandbox_usage (user_id, thread_id, cpu, memory_mib, ended_at, est_usd) values (${u}, ${t}, 1, 1024, now(), 5000)`;
    B.invalidateBudget();
    try {
      expect((await B.budgetStatus()).exhausted).toBe(true);
      expect(await A.canUseSandbox(u)).toEqual({ ok: false, reason: 'budget' });
      const swept = await L.sweepSandboxes();
      expect(swept.paused).toBeGreaterThanOrEqual(1);
      const sa2 = await newSubagent({ threadId: t, owner: u });
      expect(await call(ctxOf(t, u, sa2), 'sandbox_exec', { command: 'true' })).toMatch(/paused until next month/);
    } finally {
      await sql`delete from sandbox_usage where user_id = ${u}`;
      B.invalidateBudget();
    }
  });

  it('quota: live sandboxes per user', async () => {
    const t = await newThread();
    const u = await newUser();
    const outs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sa = await newSubagent({ threadId: t, owner: u });
      outs.push(await call(ctxOf(t, u, sa), 'sandbox_exec', { command: 'true' }));
    }
    expect(outs[2]).toMatch(/already has 2 sandboxes in use by other running subagents/);
  });

  it('quota: idle sandboxes of finished subagents do not count; the oldest idle one is paused to make room', async () => {
    const t = await newThread();
    const u = await newUser();
    const { queue, QUEUE } = await import('../core/queues.js');
    const done: { subagentId: string; runId: number }[] = [];
    for (let i = 0; i < 2; i++) {
      const sa = await newSubagent({ threadId: t, owner: u });
      expect(await call(ctxOf(t, u, sa), 'sandbox_exec', { command: 'true' })).toContain('ran: true');
      await finishRun(sa.runId);
      await hooks.onSandboxRunFinished(sa.runId);
      done.push(sa);
    }
    // Both are still live (idle, not yet paused by the sweep), but neither is in use.
    const idle = await sql<any[]>`select * from sandboxes where subagent_id in ${sql(done.map((d) => d.subagentId))} order by idle_since`;
    expect(idle.map((r) => r.state)).toEqual(['running', 'running']);
    const third = await newSubagent({ threadId: t, owner: u });
    expect(await call(ctxOf(t, u, third), 'sandbox_exec', { command: 'true' })).toContain('ran: true');
    // Live total would be 3 > 2: the oldest idle one gets a pause job.
    const job = await queue(QUEUE.sandbox).getJob(`pause-${idle[0].id}-${idle[0].generation}`);
    expect(job?.data).toMatchObject({ type: 'pause', sandboxId: idle[0].id });
    expect(await queue(QUEUE.sandbox).getJob(`pause-${idle[1].id}-${idle[1].generation}`)).toBeFalsy();
    await job!.remove();
  });

  it('HCA: positive cached as a boolean, negatives short, errors never revoke', async () => {
    const u = await newUser(false);
    const prev = H.hcaClient.check;
    let calls = 0;
    try {
      H.hcaClient.check = async () => (calls++, 'verified');
      expect(await H.checkHca(u)).toEqual({ ok: true });
      expect(await H.checkHca(u)).toEqual({ ok: true });
      expect(calls).toBe(1);
      const [row] = await sql<any[]>`select * from hca_verifications where user_id = ${u}`;
      expect(Object.keys(row).sort()).toEqual(['checkedAt', 'userId', 'verified']);
      // Stale positive + HCA down → still allowed, nothing written.
      await sql`update hca_verifications set checked_at = now() - interval '20 days' where user_id = ${u}`;
      H.hcaClient.check = async () => 'unknown';
      expect(await H.checkHca(u)).toEqual({ ok: true });
      expect(await redis.get(`hca:neg:${u}`)).toBeNull();
      // Now unverified → denied, positive removed, negative cached.
      H.hcaClient.check = async () => (calls++, 'unverified');
      expect(await H.checkHca(u)).toEqual({ ok: false, reason: 'denied' });
      expect((await sql`select 1 from hca_verifications where user_id = ${u}`).length).toBe(0);
      const c = calls;
      expect(await H.checkHca(u)).toEqual({ ok: false, reason: 'denied' });
      expect(calls).toBe(c);
      // HCA down and no positive → unavailable, not denied.
      await redis.del(`hca:neg:${u}`);
      H.hcaClient.check = async () => 'unknown';
      expect(await H.checkHca(u)).toEqual({ ok: false, reason: 'unavailable' });
    } finally {
      H.hcaClient.check = prev;
      await redis.del(`hca:neg:${u}`);
    }
  });

  describe('previews', () => {
    const site = (box: any) => {
      box.files.set('/work/site/index.html', Buffer.from('<html><head></head><body><h1>Hi</h1></body></html>'));
      box.files.set('/work/site/app.js', Buffer.from('console.log(1)'));
    };
    const fakeDeploy = vi.fn(async (o: any) => ({
      url: `https://${o.workerName}.tmp.workers.dev`,
      workerName: o.workerName,
      accountId: 'acc_1',
      apiToken: 'cf-temp-token-SECRET',
      accountExpiresAt: new Date(Date.now() + 3600_000),
      claimUrl: 'https://dash.cloudflare.com/claim/SECRET-CLAIM',
      claimExpiresAt: new Date(Date.now() + 3600_000),
    }));
    let prevDeploy: any;
    let prevTakedown: any;
    beforeAll(() => {
      prevDeploy = D.previewDeployer.deploy;
      prevTakedown = D.previewDeployer.takedown;
      D.previewDeployer.deploy = fakeDeploy as any;
      D.previewDeployer.takedown = vi.fn(async () => true);
    });
    afterAll(() => {
      D.previewDeployer.deploy = prevDeploy;
      D.previewDeployer.takedown = prevTakedown;
    });

    async function requested() {
      const t = await newThread();
      const u = await newUser();
      const sa = await newSubagent({ threadId: t, owner: u });
      const ctx = ctxOf(t, u, sa);
      await call(ctx, 'sandbox_exec', { command: 'true' });
      const [row] = await sql<any[]>`select provider_id from sandboxes where subagent_id = ${sa.subagentId}`;
      site(fake.boxes.get(row.providerId));
      const out = await call(ctx, 'request_preview', { dir: 'site', title: 'Hi page' });
      expect(out).toMatch(/Preview queued/);
      const [pv] = await sql<any[]>`select * from previews where run_id = ${sa.runId}`;
      expect(pv.status).toBe('requested');
      return { t, u, sa, ctx, pv };
    }

    it('terms → accept → deploy → message; only the requester can claim; report; expiry clears secrets', async () => {
      const { t, u, sa, pv } = await requested();
      let n = (await fakeCalls()).length;
      await finishRun(sa.runId);
      await hooks.onSandboxRunFinished(sa.runId);
      await F.preparePreview(pv.id);
      let row = await PS.getPreview(pv.id);
      expect(row!.status).toBe('awaiting_terms');
      const eph = (await callsSince(n)).filter((c) => c.method === 'chat.postEphemeral');
      expect(eph).toHaveLength(1);
      expect(eph[0]!.args.user).toBe(u);
      expect(JSON.stringify(eph[0]!.args.blocks)).toContain('preview:terms_accept');
      // Someone else can't accept.
      const [channelId, threadTs] = t.split(':');
      const click = (userId: string, actionId: string) => ({ userId, channelId, threadTs, actionId, value: pv.id, responseUrl: `https://hooks.slack.invalid/${rand()}`, body: {} });
      await F.handleTermsAccept(click('UOTHER', 'preview:terms_accept'));
      expect((await PS.getPreview(pv.id))!.status).toBe('awaiting_terms');
      // The terms prompt is an ephemeral: its button payload has no thread; the answer still goes to the thread.
      n = (await fakeCalls()).length;
      await F.handleTermsAccept({ userId: u, channelId, actionId: 'preview:terms_accept', value: pv.id, responseUrl: 'https://hooks.slack.invalid/acc', body: { container: { is_ephemeral: true } } });
      expect((await PS.getPreview(pv.id))!.status).toBe('requested');
      const accepted = await callsSince(n);
      expect(accepted.filter((c) => c.method === 'response_url').map((c) => c.args)).toEqual([{ url: 'https://hooks.slack.invalid/acc', delete_original: true }]);
      expect(accepted.find((c) => c.method === 'chat.postEphemeral')!.args).toMatchObject({ channel: channelId, thread_ts: threadTs, user: u, text: expect.stringMatching(/^Thanks\. Deploying/) });
      n = (await fakeCalls()).length;
      await F.deployPreview(pv.id);
      row = await PS.getPreview(pv.id);
      expect(row!.status).toBe('live');
      expect(row!.url).toMatch(/workers\.dev/);
      expect(row!.claimUrlEnc).toBeTruthy();
      expect(row!.bundleFileId && (await files.fileStore.get(row!.bundleFileId))).toBeFalsy();
      const deployed = fakeDeploy.mock.calls.at(-1)![0];
      const index = deployed.files.find((f: any) => f.path === 'index.html').data.toString();
      expect(index).toContain('smasnug-preview-banner');
      expect(deployed.files.map((f: any) => f.path)).toContain('_headers');
      const posts = (await callsSince(n)).filter((c) => c.method === 'chat.postMessage');
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts[0]!.args)).toContain('preview:claim');
      expect(JSON.stringify(posts[0]!.args)).not.toContain('SECRET');
      // Claim: others refused, the requester gets the URL ephemerally.
      n = (await fakeCalls()).length;
      await F.handleClaim(click('UOTHER', 'preview:claim'));
      await F.handleClaim(click(u, 'preview:claim'));
      // In the thread (chat.postEphemeral), never via response_url (that lands at the channel root).
      const claimCalls = await callsSince(n);
      expect(claimCalls.some((c) => c.method === 'response_url')).toBe(false);
      const replies = claimCalls.filter((c) => c.method === 'chat.postEphemeral');
      expect(replies.map((c) => [c.args.user, c.args.thread_ts])).toEqual([
        ['UOTHER', threadTs],
        [u, threadTs],
      ]);
      expect(replies[0]!.args.text).toMatch(/Only <@.*> can claim/);
      expect(replies[0]!.args.text).not.toContain('SECRET');
      expect(replies[1]!.args.text).toContain('https://dash.cloudflare.com/claim/SECRET-CLAIM');
      // Report → mod channel (when configured) + thanks.
      n = (await fakeCalls()).length;
      await F.handleReport(click('UOTHER', 'preview:report'));
      expect((await callsSince(n)).some((c) => c.method === 'chat.postEphemeral' && c.args.thread_ts === threadTs && /Thanks, reported/.test(c.args.text))).toBe(true);
      // No secret ever reached the thread's events.
      const evs = await sql<any[]>`select payload from thread_events where thread_id = ${t}`;
      expect(JSON.stringify(evs)).not.toContain('SECRET');
      // Expiry.
      await sql`update previews set expires_at = now() - interval '1 minute' where id = ${pv.id}`;
      n = (await fakeCalls()).length;
      await F.expirePreviews();
      row = await PS.getPreview(pv.id);
      expect(row!.status).toBe('expired');
      expect(row!.claimUrlEnc).toBeNull();
      expect(row!.apiTokenEnc).toBeNull();
      const upd = (await callsSince(n)).filter((c) => c.method === 'chat.update');
      expect(upd[0]!.args.text).toMatch(/has expired/);
      expect(JSON.stringify(upd[0]!.args.blocks)).not.toContain('preview:claim');
      await F.handleClaim(click(u, 'preview:claim'));
    });

    it('terms are asked once per version; cancel and unanswered prompts end the preview', async () => {
      const a = await requested();
      await finishRun(a.sa.runId);
      await F.preparePreview(a.pv.id);
      const [channelId, threadTs] = a.t.split(':');
      await F.handleTermsCancel({ userId: a.u, channelId, threadTs, actionId: 'preview:terms_cancel', value: a.pv.id, responseUrl: 'https://hooks.slack.invalid/x', body: {} });
      expect((await PS.getPreview(a.pv.id))!.status).toBe('cancelled');
      // Accepted earlier → straight to deploy.
      const b = await requested();
      await PS.acceptTerms(b.u);
      await finishRun(b.sa.runId);
      await F.preparePreview(b.pv.id);
      expect((await PS.getPreview(b.pv.id))!.status).toBe('requested');
      // Unanswered prompt expires.
      const c = await requested();
      await finishRun(c.sa.runId);
      await F.preparePreview(c.pv.id);
      await sql`update previews set terms_prompt_expires_at = now() - interval '1 minute' where id = ${c.pv.id}`;
      await F.expirePreviews();
      expect((await PS.getPreview(c.pv.id))!.status).toBe('cancelled');
    });

    it('a failed run drops the request; password forms are refused at deploy', async () => {
      const a = await requested();
      await finishRun(a.sa.runId, 'error');
      await hooks.onSandboxRunFinished(a.sa.runId);
      expect((await PS.getPreview(a.pv.id))!.status).toBe('cancelled');
      // A login form.
      const t = await newThread();
      const u = await newUser();
      await PS.acceptTerms(u);
      const sa = await newSubagent({ threadId: t, owner: u });
      const ctx = ctxOf(t, u, sa);
      await call(ctx, 'sandbox_exec', { command: 'true' });
      const [row] = await sql<any[]>`select provider_id from sandboxes where subagent_id = ${sa.subagentId}`;
      fake.boxes.get(row.providerId)!.files.set('/work/site/index.html', Buffer.from('<form><input name="user"><input type="password"></form>'));
      expect(await call(ctx, 'request_preview', { dir: 'site', title: 'Login' })).toMatch(/Preview queued/);
      const [pv] = await sql<any[]>`select id from previews where run_id = ${sa.runId}`;
      const calls = fakeDeploy.mock.calls.length;
      await F.deployPreview(pv.id);
      expect((await PS.getPreview(pv.id))!.status).toBe('refused');
      expect(fakeDeploy.mock.calls.length).toBe(calls);
      // No index.html → refused at request time.
      fake.boxes.get(row.providerId)!.files.set('/work/empty/readme.txt', Buffer.from('x'));
      expect(await call(ctx, 'request_preview', { dir: 'empty', title: 'x' })).toMatch(/no index\.html/);
    });
  });
});
