/**
 * The sandbox tools end to end against real Modal and the test Postgres/Redis (no model calls): a subagent writes a
 * script, runs it (matplotlib chart), looks at the PNG, exports it into the file store, then the sandbox is paused,
 * resumed with its files, and destroyed. Cleans up its sandboxes and snapshots, also on failure.
 *   LIVE=1 INTEGRATION=1 pnpm vitest run src/sandbox/tools.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN = process.env.LIVE === '1' && process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.LIVE === '1' && process.env.INTEGRATION === '1') {
    try {
      process.loadEnvFile('.env');
    } catch {}
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!RUN || !process.env.MODAL_TOKEN_ID)('sandbox tools on Modal (live)', () => {
  let sql: typeof import('../db/index.js').sql;
  let toolsFor: typeof import('../core/tools.js').toolsFor;
  let L: typeof import('./lifecycle.js');
  const ch = `CSBXLIVE${rand()}`;
  const ts = `1790${Math.floor(Math.random() * 1e6)}.000100`;
  const threadId = `${ch}:${ts}`;
  const user = `USBXLIVE${rand()}`;
  const saId = `sa_${rand().toLowerCase()}`;
  let runId = 0;

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    const { migrate } = await import('../db/migrate.js');
    await migrate();
    ({ toolsFor } = await import('../core/tools.js'));
    await import('../tools/index.js');
    L = await import('./lifecycle.js');
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${ch}, ${ts})`;
    await sql`insert into sandbox_allowlist (user_id, added_by) values (${user}, 'test')`;
    await sql`insert into subagents (id, thread_id, owner_id, title, status, sandbox) values (${saId}, ${threadId}, ${user}, 'Live', 'running', true)`;
    const [r] = await sql<{ id: number }[]>`insert into runs (subagent_id, thread_id, instructions, status) values (${saId}, ${threadId}, 'x', 'running') returning id`;
    runId = Number(r!.id);
  });

  afterAll(async () => {
    if (!sql) return;
    const rows = await sql<{ id: string }[]>`select id from sandboxes where thread_id = ${threadId}`;
    for (const r of rows) await L.destroySandbox(r.id).catch(() => {});
    await sql`delete from sandboxes where thread_id = ${threadId}`;
    await sql`delete from sandbox_usage where thread_id = ${threadId}`;
    await sql`delete from files where thread_id = ${threadId}`;
    await sql`delete from sandbox_allowlist where user_id = ${user}`;
    await sql`delete from sandbox_first_use where user_id = ${user}`;
    await sql`delete from threads where id = ${threadId}`;
    await sql.end();
  }, 120_000);

  const ctx = () => ({ threadId, channelId: ch, threadTs: ts, speakerId: user, subagentId: saId, runId, extras: {} });
  const call = (name: string, input: object) => (toolsFor('child', ctx())[name] as any).execute(input, { toolCallId: `tc${rand()}`, messages: [] });

  it('write → exec → look at the chart → export → pause → resume → destroy', async () => {
    const script = "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nplt.bar(['a','b','c'], [3,1,2])\nplt.savefig('/work/out/chart.png')\nprint('saved')\n";
    expect(await call('sandbox_write_file', { path: 'plot.py', content: script })).toMatch(/Wrote \/work\/plot\.py/);
    const ran = await call('sandbox_exec', { command: 'mkdir -p out && python3 plot.py && ls -l out', timeout_s: 120 });
    expect(ran).toMatch(/exit code 0/);
    expect(ran).toContain('saved');
    const img = await (toolsFor('child', ctx()).sandbox_read_file as any).execute({ path: 'out/chart.png' }, { toolCallId: 't', messages: [] });
    expect(typeof img).toBe('object');
    expect(img.mediaType).toMatch(/^image\//);
    const exported = await call('sandbox_export', { path: 'out/chart.png', description: 'Bar chart' });
    const id = /file_[a-z0-9]{10}/.exec(exported)?.[0];
    expect(id).toBeTruthy();
    const [f] = await sql<{ mime: string; size: number; createdRunId: number }[]>`select mime, size, created_run_id from files where id = ${id!}`;
    expect(f!.mime).toBe('image/png');
    expect(Number(f!.createdRunId)).toBe(runId);

    // Pause (as the idle sweep would) and resume on the next call: the files are still there.
    const [row] = await sql<any[]>`select * from sandboxes where subagent_id = ${saId}`;
    await sql`update runs set status = 'complete' where id = ${runId}`;
    expect(await L.pauseSandbox(row.id, { generation: row.generation })).toBe('paused');
    const [r2] = await sql<{ id: number }[]>`insert into runs (subagent_id, thread_id, instructions, status, is_resume) values (${saId}, ${threadId}, 'more', 'running', true) returning id`;
    runId = Number(r2!.id);
    const again = await call('sandbox_exec', { command: 'ls out; whoami' });
    expect(again).toContain('chart.png');
    expect(again).toContain('sandbox');

    await L.destroySandbox(row.id);
    const [end] = await sql<any[]>`select state, provider_id, paused_ref from sandboxes where id = ${row.id}`;
    expect(end).toMatchObject({ state: 'destroyed', providerId: null, pausedRef: null });
    const [seg] = await sql<{ n: number; usd: number }[]>`select count(*)::int as n, sum(est_usd)::float8 as usd from sandbox_usage where sandbox_id = ${row.id} and ended_at is not null`;
    expect(seg!.n).toBe(2);
    expect(seg!.usd).toBeGreaterThan(0);
    expect(seg!.usd).toBeLessThan(0.05);
  }, 600_000);
});
