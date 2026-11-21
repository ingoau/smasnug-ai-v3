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

  it('any subagent may use the tools (the first allowed call marks it and tells its run); users without access are refused', async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u, sandbox: false });
    let started = 0;
    const ctx = { ...ctxOf(t, u, sa), extras: { onSandboxStarted: () => void started++ } };
    expect(await call(ctx, 'sandbox_exec', { command: 'ls' })).not.toMatch(/only available/);
    expect(started).toBe(1);
    const [marked] = await sql<{ sandbox: boolean }[]>`select sandbox from subagents where id = ${sa.subagentId}`;
    expect(marked!.sandbox).toBe(true);
    const created = fake.counts.create;
    const stranger = await newUser(false);
    const sa2 = await newSubagent({ threadId: t, owner: stranger, sandbox: false });
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
    expect(fake.counts.create).toBe(created);
    const [refused] = await sql<{ sandbox: boolean }[]>`select sandbox from subagents where id = ${sa2.subagentId}`;
    expect(refused!.sandbox).toBe(false);
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

  it('a finished run pauses its sandbox after a short grace (delayed job), so idle time is not charged', async () => {
    const { queue, QUEUE } = await import('../core/queues.js');
    const { limits } = await import('../config.js');
    const delayedPause = async (sandboxId: string) =>
      (await queue(QUEUE.sandbox).getJobs(['delayed', 'waiting'])).filter((j) => j.data.type === 'pause' && j.data.sandboxId === sandboxId);
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent({ threadId: t, owner: u });
    const ctx = ctxOf(t, u, sa);
    await call(ctx, 'sandbox_exec', { command: 'echo hi' });
    const [row] = await sql<any[]>`select * from sandboxes where subagent_id = ${sa.subagentId}`;

    // Another run of the same subagent is queued: no early pause.
    const [queued] = await sql<{ id: number }[]>`insert into runs (subagent_id, thread_id, instructions, status, is_resume) values (${sa.subagentId}, ${t}, 'next', 'queued', true) returning id`;
    await finishRun(sa.runId);
    await hooks.onSandboxRunFinished(sa.runId);
    expect(await delayedPause(row.id)).toHaveLength(0);
    await sql`update runs set status = 'cancelled', finished_at = now() where id = ${queued!.id}`;

    // The last run ended: one delayed pause job.
    await hooks.onSandboxRunFinished(Number(queued!.id));
    const jobs = await delayedPause(row.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.opts.delay).toBe(limits.sandboxRunEndPauseMs);
    expect(jobs[0]!.data).toMatchObject({ generation: row.generation, minIdleMs: limits.sandboxRunEndPauseMs });
    await jobs[0]!.remove();

    // Used again within the grace (idle_since cleared): the job is a no-op.
    await call({ ...ctx, runId: Number(queued!.id) }, 'sandbox_exec', { command: 'echo again' });
    expect(await L.pauseSandbox(row.id, jobs[0]!.data)).toBe('skipped');
    // Idle for the whole grace: paused, and its usage segment closed (charged up to now, not the 5-min idle pause).
    await sql`update sandboxes set idle_since = now() - ${limits.sandboxRunEndPauseMs} * interval '1 millisecond' where id = ${row.id}`;
    expect(await L.pauseSandbox(row.id, jobs[0]!.data)).toBe('paused');
    const open = await sql`select 1 from sandbox_usage where sandbox_id = ${row.id} and ended_at is null`;
    expect(open).toHaveLength(0);
    expect(await B.userMinutesToday(u)).toBeLessThan(1);
  });

  it('isIdleFor: idle for the grace (with a little clock skew), never when in use', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(L.isIdleFor(null, 45_000, now)).toBe(false);
    expect(L.isIdleFor(new Date(now - 44_000), 45_000, now)).toBe(true); // within the 2 s skew
    expect(L.isIdleFor(new Date(now - 30_000), 45_000, now)).toBe(false);
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
    // Export: a 6 MB file is stored, and it's idempotent.
    const big = randomBytes(6 * 1024 * 1024);
    const [row] = await sql<any[]>`select provider_id from sandboxes where subagent_id = ${saA.subagentId}`;
    fake.boxes.get(row.providerId)!.files.set('/work/out/big.bin', big);
    const e1 = await call(ctxOf(tA, u, saA), 'sandbox_export', { path: 'out/big.bin', description: 'random bytes' });
    const e2 = await call(ctxOf(tA, u, saA), 'sandbox_export', { path: 'out/big.bin', description: 'random bytes' });
    const id = /file_[a-z0-9]{10}/.exec(e1)![0];
    expect(e2).toContain(id);
    const listed = await files.filesCreatedByRuns([saA.runId]);
    expect(listed.get(saA.runId)!.map((f) => f.id)).toContain(id);
    // Over the store's cap: a large file (streamed out, kept as a private Slack upload); over Slack's limit: refused.
    const { limits } = await import('../config.js');
    const saved = { export: limits.sandboxExportMaxBytes, large: limits.largeFileMaxBytes };
    try {
      (limits as any).sandboxExportMaxBytes = 1024 * 1024;
      fake.boxes.get(row.providerId)!.files.set('/work/out/huge.bin', Buffer.alloc(2 * 1024 * 1024, 1));
      const e3 = await call(ctxOf(tA, u, saA), 'sandbox_export', { path: 'out/huge.bin', description: 'x' });
      expect(e3).toMatch(/can be posted with reply\(files\), but not opened/);
      const big3 = await files.fileStore.metadata(/file_[a-z0-9]{10}/.exec(e3)![0]);
      expect(big3).toMatchObject({ hasContent: false, size: 2 * 1024 * 1024 });
      expect(big3!.blobSlackFileId).toBeTruthy();
      (limits as any).largeFileMaxBytes = 1.5 * 1024 * 1024;
      expect(await call(ctxOf(tA, u, saA), 'sandbox_export', { path: 'out/huge.bin', description: 'x' })).toMatch(/2\.0 MB; the most the bot can post to Slack is 1\.5 MB/);
    } finally {
      (limits as any).sandboxExportMaxBytes = saved.export;
      (limits as any).largeFileMaxBytes = saved.large;
    }
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

    let prevWait = 0;
    beforeAll(async () => {
      const { limits } = await import('../config.js');
      prevWait = limits.previewTermsWaitMs;
      (limits as { previewTermsWaitMs: number }).previewTermsWaitMs = 400;
    });
    afterAll(async () => {
      const { limits } = await import('../config.js');
      (limits as { previewTermsWaitMs: number }).previewTermsWaitMs = prevWait;
    });

    /** A thread, user and running sandbox subagent with a site in /work/site. */
    async function setup(o: { accepted?: boolean } = {}) {
      const t = await newThread();
      const u = await newUser();
      if (o.accepted) await PS.acceptTerms(u);
      const sa = await newSubagent({ threadId: t, owner: u });
      const ctx = ctxOf(t, u, sa);
      await call(ctx, 'sandbox_exec', { command: 'true' });
      const [row] = await sql<any[]>`select provider_id from sandboxes where subagent_id = ${sa.subagentId}`;
      const box = fake.boxes.get(row.providerId);
      site(box);
      const [channelId, threadTs] = t.split(':') as [string, string];
      return { t, u, sa, ctx, box, channelId, threadTs };
    }
    const latest = async (runId: number) => (await sql<any[]>`select * from previews where run_id = ${runId} order by created_at desc`)[0];

    it('accepted terms: request_preview deploys inline and returns the URL + id; nothing posted; claim, report, expiry', async () => {
      const { t, u, sa, ctx, channelId, threadTs } = await setup({ accepted: true });
      let n = (await fakeCalls()).length;
      const out = await call(ctx, 'request_preview', { dir: 'site', title: 'Hi page' });
      const pv = await latest(sa.runId);
      expect(out).toMatch(/^Deployed: https:\/\/smasnug-p-.*workers\.dev/);
      expect(out).toContain(`preview id ${pv.id}`);
      expect(out).not.toContain('SECRET');
      const row = await PS.getPreview(pv.id);
      expect(row!.status).toBe('live');
      expect(row!.claimUrlEnc).toBeTruthy();
      expect(row!.bundleFileId && (await files.fileStore.get(row!.bundleFileId))).toBeFalsy();
      const deployed = fakeDeploy.mock.calls.at(-1)![0];
      expect(deployed.files.find((f: any) => f.path === 'index.html').data.toString()).toContain('smasnug-preview-banner');
      expect(deployed.files.map((f: any) => f.path)).toContain('_headers');
      // Inline: code posts nothing (the front agent posts the link with reply(preview)).
      expect((await callsSince(n)).filter((c) => c.method === 'chat.postMessage' || c.method === 'chat.postEphemeral')).toHaveLength(0);
      // The reply's buttons for it: only for this thread and a live preview.
      const { previewReplyExtras } = await import('./preview/reply-blocks.js');
      const ok = await previewReplyExtras(t, pv.id);
      expect(ok.note).toBeNull();
      expect(JSON.stringify(ok.items.map((i) => i.block))).toContain('preview:claim');
      expect((await previewReplyExtras('COTHER:1.000001', pv.id)).items).toHaveLength(0);
      expect((await previewReplyExtras(t, 'pv_nope')).note).toMatch(/No preview/);
      // Claim: others refused, the requester gets the URL ephemerally in the thread.
      const click = (userId: string) => ({ userId, channelId, threadTs, actionId: 'preview:claim', value: pv.id, responseUrl: `https://hooks.slack.invalid/${rand()}`, body: {} });
      n = (await fakeCalls()).length;
      await F.handleClaim(click('UOTHER'));
      await F.handleClaim(click(u));
      const claimCalls = await callsSince(n);
      expect(claimCalls.some((c) => c.method === 'response_url')).toBe(false);
      const replies = claimCalls.filter((c) => c.method === 'chat.postEphemeral');
      expect(replies.map((c) => [c.args.user, c.args.thread_ts])).toEqual([
        ['UOTHER', threadTs],
        [u, threadTs],
      ]);
      expect(replies[0]!.args.text).toMatch(/Only <@.*> can claim/);
      expect(replies[1]!.args.text).toContain('https://dash.cloudflare.com/claim/SECRET-CLAIM');
      n = (await fakeCalls()).length;
      await F.handleReport({ ...click('UOTHER'), actionId: 'preview:report' });
      expect((await callsSince(n)).some((c) => c.method === 'chat.postEphemeral' && c.args.thread_ts === threadTs && /Thanks, reported/.test(c.args.text))).toBe(true);
      const evs = await sql<any[]>`select payload from thread_events where thread_id = ${t}`;
      expect(JSON.stringify(evs)).not.toContain('SECRET');
      // A fixed site in the same run deploys again (a new row; the live one stays).
      expect(await call(ctx, 'request_preview', { dir: 'site', title: 'Hi page v2' })).toMatch(/^Deployed:/);
      expect(await sql`select id from previews where run_id = ${sa.runId}`).toHaveLength(2);
      // Expiry: secrets gone, no message edited.
      await sql`update previews set expires_at = now() - interval '1 minute' where id = ${pv.id}`;
      n = (await fakeCalls()).length;
      await F.expirePreviews();
      const ended = await PS.getPreview(pv.id);
      expect(ended!.status).toBe('expired');
      expect(ended!.claimUrlEnc).toBeNull();
      expect(ended!.apiTokenEnc).toBeNull();
      expect((await callsSince(n)).filter((c) => c.method === 'chat.update')).toHaveLength(0);
    });

    it('first time: accepted while the call waits → the call deploys (no job)', async () => {
      const { u, sa, ctx, channelId } = await setup();
      const { limits } = await import('../config.js');
      (limits as { previewTermsWaitMs: number }).previewTermsWaitMs = 5000;
      try {
        const n = (await fakeCalls()).length;
        const pending = call(ctx, 'request_preview', { dir: 'site', title: 'Hi page' });
        let pv: any;
        for (let i = 0; i < 100 && pv?.status !== 'awaiting_terms'; i++) {
          await new Promise((r) => setTimeout(r, 50));
          pv = await latest(sa.runId);
        }
        expect(pv.status).toBe('awaiting_terms');
        expect(new Date(pv.inlineUntil).getTime()).toBeGreaterThan(Date.now());
        const eph = (await callsSince(n)).filter((c) => c.method === 'chat.postEphemeral');
        expect(eph).toHaveLength(1);
        expect(JSON.stringify(eph[0]!.args.blocks)).toContain('preview:terms_accept');
        // Someone else can't accept.
        await F.handleTermsAccept({ userId: 'UOTHER', channelId, actionId: 'preview:terms_accept', value: pv.id, responseUrl: 'https://hooks.slack.invalid/o', body: {} });
        expect((await PS.getPreview(pv.id))!.status).toBe('awaiting_terms');
        await F.handleTermsAccept({ userId: u, channelId, actionId: 'preview:terms_accept', value: pv.id, responseUrl: 'https://hooks.slack.invalid/acc', body: { container: { is_ephemeral: true } } });
        expect(await pending).toMatch(/^Deployed:/);
        const row = await PS.getPreview(pv.id);
        expect(row!.status).toBe('live');
        expect(row!.inlineUntil).toBeNull();
      } finally {
        (limits as { previewTermsWaitMs: number }).previewTermsWaitMs = 400;
      }
    });

    it('first time, no answer in time: waiting; a later accept deploys by job and tells the front agent', async () => {
      const { t, u, sa, ctx, channelId } = await setup();
      const out = await call(ctx, 'request_preview', { dir: 'site', title: 'Hi page' });
      expect(out).toMatch(/^Preview waiting/);
      const pv = await latest(sa.runId);
      expect(pv.status).toBe('awaiting_terms');
      expect(pv.inlineUntil).toBeNull();
      expect(F.acceptedInline(pv)).toBe(false);
      // Requested again while the prompt is open: same row, new files, still waiting.
      expect(await call(ctx, 'request_preview', { dir: 'site', title: 'Hi page v2' })).toMatch(/^Preview waiting/);
      expect(await sql`select id from previews where run_id = ${sa.runId}`).toHaveLength(1);
      expect((await PS.getPreview(pv.id))!.title).toBe('Hi page v2');
      // The run ends: the prompt stays open.
      await finishRun(sa.runId);
      await hooks.onSandboxRunFinished(sa.runId);
      expect((await PS.getPreview(pv.id))!.status).toBe('awaiting_terms');
      await F.handleTermsAccept({ userId: u, channelId, actionId: 'preview:terms_accept', value: pv.id, responseUrl: 'https://hooks.slack.invalid/acc', body: {} });
      expect((await PS.getPreview(pv.id))!.status).toBe('requested');
      const n = (await fakeCalls()).length;
      await F.deployPreview(pv.id);
      const row = await PS.getPreview(pv.id);
      expect(row!.status).toBe('live');
      // An outcome turn tells the front agent to post it; code posts nothing itself.
      const [sti] = await sql<any[]>`select source, input, fallback from scheduled_turn_inputs where source = 'preview' and source_ref = ${pv.id}`;
      expect(sti.input).toContain(row!.url);
      expect(sti.input).toContain(`preview: "${pv.id}"`);
      expect(sti.fallback).toContain(row!.url);
      expect((await callsSince(n)).filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
      // Its fallback, if the turn shows nothing: the code message with the claim button.
      const { renderOutcomeFallback } = await import('../features/outcome-turn.js');
      const fb = await renderOutcomeFallback('preview', pv.id, sti.fallback);
      expect(JSON.stringify(fb!.blocks)).toContain('preview:claim');
      // Posted meanwhile (a reply with preview, or the results turn's safety net): the turn becomes "do nothing".
      const { outcomeObsolete } = await import('../features/outcome-turn.js');
      expect(await outcomeObsolete('preview', pv.id)).toBeNull();
      await PS.markAnnounced(pv.id);
      expect(await outcomeObsolete('preview', pv.id)).toMatch(/already posted.*end_turn/);
      expect(t).toBeTruthy();
    });

    it('abort: before the deploy the request is cancelled; after it, the front agent is told like a late deploy', async () => {
      const a = await setup({ accepted: true });
      const { id } = await PS.upsertRequestedPreview({ runId: a.sa.runId, subagentId: a.sa.subagentId, threadId: a.t, requesterId: a.u, title: 'Stopped', bundleFileId: 'file_none' });
      const stopped = new AbortController();
      stopped.abort();
      expect(await F.deployInline(id, { abortSignal: stopped.signal })).toMatch(/run was stopped/);
      expect((await PS.getPreview(id))!.status).toBe('cancelled');
      // Aborted while deploying: it goes live and an outcome turn tells the front agent.
      const b = await setup({ accepted: true });
      const ac = new AbortController();
      const impl = fakeDeploy.getMockImplementation()!;
      fakeDeploy.mockImplementationOnce(async (o: any) => {
        ac.abort();
        return impl(o);
      });
      const out = await (toolsFor('child', b.ctx).request_preview as any).execute({ dir: 'site', title: 'Hi page' }, { toolCallId: `tc${rand()}`, messages: [], abortSignal: ac.signal });
      expect(out).toMatch(/^Deployed:/);
      const pv = await latest(b.sa.runId);
      expect(pv.status).toBe('live');
      const [sti] = await sql<any[]>`select input from scheduled_turn_inputs where source = 'preview' and source_ref = ${pv.id}`;
      expect(sti.input).toContain(pv.url);
      expect(sti.input).not.toContain('after the run finished');
    });

    it('announcement: the safety net posts unannounced live previews once; an announced one is skipped', async () => {
      const a = await setup({ accepted: true });
      await call(a.ctx, 'request_preview', { dir: 'site', title: 'One' });
      const one = await latest(a.sa.runId);
      await call(a.ctx, 'request_preview', { dir: 'site', title: 'Two' });
      const two = await latest(a.sa.runId);
      expect(two.id).not.toBe(one.id);
      await PS.markAnnounced(two.id);
      const two2 = await PS.getPreview(two.id);
      expect(two2!.announcedAt).toBeTruthy();
      expect(two2!.messageTs).toBeNull(); // a front reply: never rewritten by takedown
      const { postUnannouncedPreviews } = await import('./preview/reply-blocks.js');
      let n = (await fakeCalls()).length;
      expect(await postUnannouncedPreviews([a.sa.runId])).toHaveLength(1);
      const posts = (await callsSince(n)).filter((c) => c.method === 'chat.postMessage');
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts[0]!.args)).toContain(one.id);
      expect(JSON.stringify(posts[0]!.args)).toContain('preview:claim');
      const row = await PS.getPreview(one.id);
      expect(row!.messageTs).toBeTruthy();
      expect(row!.announcedAt).toBeTruthy();
      n = (await fakeCalls()).length;
      expect(await postUnannouncedPreviews([a.sa.runId])).toHaveLength(0);
      expect((await callsSince(n)).filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
    });

    it('daily cap: failed previews (our side) don\'t count, refused ones do', async () => {
      const t = await newThread();
      const u = await newUser();
      const before = await PS.previewCountsToday(u);
      await sql`insert into previews (id, thread_id, requester_id, title, status) values (${`pv_f${rand()}`}, ${t}, ${u}, 'f', 'failed'), (${`pv_r${rand()}`}, ${t}, ${u}, 'r', 'refused')`;
      expect((await PS.previewCountsToday(u)).user).toBe(before.user + 1);
    });

    it('accept-handler coordination: a waiting call means no job', () => {
      expect(F.acceptedInline({ inlineUntil: new Date(Date.now() + 10_000) })).toBe(true);
      expect(F.acceptedInline({ inlineUntil: new Date(Date.now() - 1) })).toBe(false);
      expect(F.acceptedInline({ inlineUntil: null })).toBe(false);
    });

    it('cancel and unanswered prompts end the preview; a request left at run end is prepared by the jobs', async () => {
      const a = await setup();
      expect(await call(a.ctx, 'request_preview', { dir: 'site', title: 'Hi page' })).toMatch(/^Preview waiting/);
      const apv = await latest(a.sa.runId);
      await F.handleTermsCancel({ userId: a.u, channelId: a.channelId, threadTs: a.threadTs, actionId: 'preview:terms_cancel', value: apv.id, responseUrl: 'https://hooks.slack.invalid/x', body: {} });
      expect((await PS.getPreview(apv.id))!.status).toBe('cancelled');
      // Unanswered prompt expires.
      const c = await setup();
      await call(c.ctx, 'request_preview', { dir: 'site', title: 'Hi page' });
      const cpv = await latest(c.sa.runId);
      await sql`update previews set terms_prompt_expires_at = now() - interval '1 minute' where id = ${cpv.id}`;
      await F.expirePreviews();
      expect((await PS.getPreview(cpv.id))!.status).toBe('cancelled');
      // A `requested` row left when the run ended (the call never got to deploy) → prepare → deploy job.
      const b = await setup({ accepted: true });
      const { id } = await PS.upsertRequestedPreview({ runId: b.sa.runId, subagentId: b.sa.subagentId, threadId: b.t, requesterId: b.u, title: 'Left', bundleFileId: 'file_none' });
      await finishRun(b.sa.runId);
      await hooks.onSandboxRunFinished(b.sa.runId);
      await F.preparePreview(id);
      expect((await PS.getPreview(id))!.status).toBe('requested');
    });

    it('a failed run drops a waiting request; password forms are refused inline', async () => {
      const a = await setup();
      expect(await call(a.ctx, 'request_preview', { dir: 'site', title: 'Hi page' })).toMatch(/^Preview waiting/);
      const apv = await latest(a.sa.runId);
      await finishRun(a.sa.runId, 'error');
      await hooks.onSandboxRunFinished(a.sa.runId);
      expect((await PS.getPreview(apv.id))!.status).toBe('cancelled');
      // A login form.
      const b = await setup({ accepted: true });
      b.box!.files.set('/work/site/index.html', Buffer.from('<form><input name="user"><input type="password"></form>'));
      const calls = fakeDeploy.mock.calls.length;
      expect(await call(b.ctx, 'request_preview', { dir: 'site', title: 'Login' })).toMatch(/^Preview refused/);
      expect((await latest(b.sa.runId)).status).toBe('refused');
      expect(fakeDeploy.mock.calls.length).toBe(calls);
      // No index.html → refused at request time.
      b.box!.files.set('/work/empty/readme.txt', Buffer.from('x'));
      expect(await call(b.ctx, 'request_preview', { dir: 'empty', title: 'x' })).toMatch(/no index\.html/);
    });
  });
});
