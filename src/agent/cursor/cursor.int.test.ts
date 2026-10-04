/**
 * Coding agents (Cursor) against the test Postgres/Redis with an in-memory fake Cursor API (no real agents launched).
 * Run: INTEGRATION=1 pnpm vitest run src/agent/cursor/cursor.int.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorAgent, CursorClient, CursorRun } from './api.js';

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
  process.env.ADMIN_USER_ID = 'UADMIN';
  process.env.CURSOR_API_KEY = 'crsr_test';
  process.env.CURSOR_REPO = 'https://github.com/ingoau/smasnug-ai-v3';
  process.env.CURSOR_REF = 'main';
});

const REPO = 'https://github.com/ingoau/smasnug-ai-v3';
const PR = 'https://github.com/ingoau/smasnug-ai-v3/pull/42';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-memory Cursor API with the documented semantics (409s, one active run per agent). */
class FakeCursor implements CursorClient {
  agents = new Map<string, { agent: CursorAgent; runs: CursorRun[]; prompts: string[] }>();
  calls: string[] = [];
  failCreate: Error | null = null;
  delayMs = 0;
  private n = 0;

  private async tick(call: string) {
    this.calls.push(call);
    if (this.delayMs) await sleep(this.delayMs);
  }
  private async err(status: number, code: string): Promise<never> {
    const { CursorApiError } = await import('./api.js');
    throw new CursorApiError(status, code, `Cursor API ${status} ${code}`);
  }
  private newRun(agentId: string): CursorRun {
    return { id: `run-${++this.n}`, agentId, status: 'CREATING' };
  }
  latest(agentId: string): CursorRun {
    const a = this.agents.get(agentId)!;
    return a.runs[a.runs.length - 1]!;
  }
  set(agentId: string, patch: Partial<CursorRun>) {
    Object.assign(this.latest(agentId), patch);
  }
  only(): string {
    expect(this.agents.size).toBe(1);
    return [...this.agents.keys()][0]!;
  }

  async createAgent(input: Parameters<CursorClient['createAgent']>[0]) {
    await this.tick('createAgent');
    if (this.failCreate) throw this.failCreate;
    if (this.agents.has(input.agentId)) return this.err(409, 'agent_id_conflict');
    const run = this.newRun(input.agentId);
    const agent: CursorAgent = { id: input.agentId, status: 'ACTIVE', url: `https://cursor.com/agents/${input.agentId}`, latestRunId: run.id };
    this.agents.set(input.agentId, { agent, runs: [run], prompts: [input.promptText] });
    return { agent, run: { ...run } };
  }
  async getAgent(agentId: string) {
    await this.tick('getAgent');
    const a = this.agents.get(agentId);
    if (!a) return this.err(404, 'agent_not_found');
    return a.agent;
  }
  async getRun(agentId: string, runId: string) {
    await this.tick('getRun');
    const run = this.agents.get(agentId)?.runs.find((r) => r.id === runId);
    if (!run) return this.err(404, 'run_not_found');
    return { ...run };
  }
  async createRun(agentId: string, promptText: string) {
    await this.tick('createRun');
    const a = this.agents.get(agentId);
    if (!a) return this.err(404, 'agent_not_found');
    if (a.agent.status === 'ARCHIVED') return this.err(409, 'agent_archived');
    if (a.runs.some((r) => r.status === 'CREATING' || r.status === 'RUNNING')) return this.err(409, 'agent_busy');
    const run = this.newRun(agentId);
    a.runs.push(run);
    a.prompts.push(promptText);
    a.agent.latestRunId = run.id;
    return { ...run };
  }
  async cancelRun(agentId: string, runId: string) {
    await this.tick('cancelRun');
    const run = this.agents.get(agentId)?.runs.find((r) => r.id === runId);
    if (!run) return this.err(404, 'run_not_found');
    if (run.status !== 'CREATING' && run.status !== 'RUNNING') return this.err(409, 'run_not_cancellable');
    run.status = 'CANCELLED';
  }
  async listAgents() {
    return { items: [...this.agents.values()].map((a) => a.agent) };
  }
  async me() {
    return { apiKeyName: 'fake' };
  }
}

describe.skipIf(!INTEGRATION)('coding agents (Cursor)', () => {
  let sql: typeof import('../../db/index.js').sql;
  let redis: typeof import('../../core/redis.js').redis;
  let api: typeof import('./api.js');
  let agents: typeof import('./agents.js');
  let sub: typeof import('../subagents.js');
  let maint: typeof import('../maintenance.js');
  let fake: FakeCursor;
  let prFiles: string[] | Error;
  const threads: string[] = [];

  async function newThread() {
    const channelId = `CCUR${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const threadTs = `17910${Math.floor(Math.random() * 1e5)}.000100`;
    const threadId = `${channelId}:${threadTs}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channelId}, ${threadTs})`;
    threads.push(threadId);
    return threadId;
  }
  async function newTurn(threadId: string, author = 'UADMIN') {
    const [t] = await sql<{ id: number }[]>`insert into turns (thread_id, author_id, status) values (${threadId}, ${author}, 'running') returning id::int as id`;
    return t!.id;
  }
  async function spawn(threadId: string, instructions = 'Make reminders accept "tmrw".') {
    const turnId = await newTurn(threadId);
    const r = await agents.spawnCodingAgent({ threadId, turnId, ownerId: 'UADMIN', title: 'Fix tmrw parsing', instructions });
    return { ...r, turnId };
  }
  /** Make the run due and poll just that run. */
  async function poll(runId: number) {
    await sql`update cursor_runs set next_poll_at = now() where run_id = ${runId}`;
    return agents.pollCursorRuns({ runId });
  }
  const runRow = async (id: number) => (await sql<any[]>`select * from runs where id = ${id}`)[0];
  const subRow = async (id: string) => (await sql<any[]>`select * from subagents where id = ${id}`)[0];
  const synthTurns = async (cardId: number) => sql<any[]>`select * from turns where card_id = ${cardId} and kind = 'synthesis'`;

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    ({ redis } = await import('../../core/redis.js'));
    const { migrate } = await import('../../db/migrate.js');
    await migrate();
    api = await import('./api.js');
    agents = await import('./agents.js');
    sub = await import('../subagents.js');
    maint = await import('../maintenance.js');
    // Earlier runs' leftovers must not be polled by this run.
    await sql`delete from cursor_runs`;
  });

  beforeEach(async () => {
    // Coding agents earlier tests left running would count against the global cap.
    await sql`update runs set status = 'error', finished_at = now() where status = 'running' and id in (select run_id from cursor_runs)`;
    fake = new FakeCursor();
    api.setCursorClientForTests(fake);
    prFiles = ['src/features/schedule/time.ts', 'src/features/schedule/time.test.ts'];
    agents.setPrFilesForTests(async () => (prFiles instanceof Error ? { error: prFiles.message } : { files: prFiles }));
  });

  afterAll(async () => {
    if (!sql) return;
    api.setCursorClientForTests(null);
    agents.setPrFilesForTests(null);
    if (threads.length) await sql`delete from threads where id in ${sql(threads)}`;
    const { closeQueues } = await import('../../core/queues.js');
    await closeQueues();
    await sql.end();
    redis.disconnect();
  });

  it('spawn → RUNNING → FINISHED with a PR → run complete → one synthesis turn with the PR link', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    expect(agentId).toMatch(/^bc-[0-9a-f-]{36}$/);
    const prompt = fake.agents.get(agentId)!.prompts[0]!;
    expect(prompt).toContain('.github/workflows/');
    expect(prompt).toContain('<task>\nMake reminders accept "tmrw".\n</task>');

    expect(await subRow(s.subagentId)).toMatchObject({ kind: 'cursor', cursorAgentId: agentId, status: 'running', cursorAgentUrl: `https://cursor.com/agents/${agentId}` });
    let run = await runRow(s.runId);
    expect(run).toMatchObject({ status: 'running', workerId: null, details: 'Starting the Cursor agent…' });
    expect(Number(run.cardId)).toBe(s.cardId);
    expect(run.sources).toEqual([{ url: `https://cursor.com/agents/${agentId}`, title: 'Cursor agent' }]);

    // Not due yet: the poller leaves it alone.
    expect(await agents.pollCursorRuns({ runId: s.runId })).toBe(0);

    fake.set(agentId, { status: 'RUNNING' });
    expect(await poll(s.runId)).toBe(1);
    run = await runRow(s.runId);
    expect(run.status).toBe('running');
    expect(run.details).toBe('Coding in Cursor…');
    const cr = (await sql<any[]>`select * from cursor_runs where run_id = ${s.runId}`)[0];
    expect(cr).toMatchObject({ cursorStatus: 'RUNNING', claimId: null, pollErrors: 0 });
    expect(cr.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    fake.set(agentId, {
      status: 'FINISHED',
      result: 'Added "tmrw" to the duration parser, with tests. typecheck + test pass. Review found nothing else.',
      git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', branch: 'cursor/tmrw-a1b2', prUrl: PR }] },
    });
    await poll(s.runId);
    run = await runRow(s.runId);
    expect(run.status).toBe('complete');
    expect(run.output).toBe('Opened PR #42');
    expect(run.result).toContain(`Pull request (open, not merged): ${PR} (branch cursor/tmrw-a1b2)`);
    expect(run.result).toContain('Changed files: 2 (no CI configuration touched).');
    expect(run.result).toContain('Added "tmrw" to the duration parser');
    expect(run.sources.map((x: any) => x.url)).toEqual([PR, `https://cursor.com/agents/${agentId}`]);
    expect((await subRow(s.subagentId)).status).toBe('idle');
    expect((await sql<any[]>`select pr_url from cursor_runs where run_id = ${s.runId}`)[0].prUrl).toBe(PR);

    const turns = await synthTurns(s.cardId);
    expect(turns).toHaveLength(1);
    expect(turns[0].authorId).toBe('UADMIN');
    // The synthesis turn renders the card's results: the PR link reaches the front agent.
    const { renderCardResults } = await import('../front.js');
    expect((await renderCardResults(s.cardId)).text).toContain(PR);

    // Polling again does nothing (the run is terminal).
    expect(await poll(s.runId)).toBe(0);
    expect(await synthTurns(s.cardId)).toHaveLength(1);
  });

  it('flags a PR that touches .github/workflows/ loudly', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    prFiles = ['src/a.ts', '.github/workflows/container.yml'];
    fake.set(agentId, { status: 'FINISHED', result: 'done', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId);
    const run = await runRow(s.runId);
    expect(run.status).toBe('complete');
    expect(run.output).toBe('Opened PR #42 ⚠️ touches CI config');
    expect(run.result).toMatch(/⚠️ WARNING: this PR changes CI \/ repository-policy configuration \(\.github\/workflows\/container\.yml\)/);
  });

  it('says so when the changed files could not be checked, and when no PR was opened', async () => {
    const t = await newThread();
    const s = await spawn(t);
    prFiles = new Error('GitHub API 403');
    fake.set(fake.only(), { status: 'FINISHED', result: 'ok', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId);
    expect((await runRow(s.runId)).result).toMatch(/couldn't be checked for CI-config changes \(GitHub API 403\)/);

    const t2 = await newThread();
    fake = new FakeCursor();
    api.setCursorClientForTests(fake);
    const s2 = await spawn(t2);
    fake.set(fake.only(), { status: 'FINISHED', result: 'Nothing to change.' });
    await poll(s2.runId);
    const run2 = await runRow(s2.runId);
    expect(run2).toMatchObject({ status: 'complete', output: 'Finished without opening a PR' });
    expect(run2.result).toMatch(/No pull request was opened/);
  });

  it('admin only: spawn, steer and cancel are refused for other users', async () => {
    const t = await newThread();
    const turnId = await newTurn(t, 'UOTHER');
    await expect(agents.spawnCodingAgent({ threadId: t, turnId, ownerId: 'UOTHER', title: 'x', instructions: 'y' })).rejects.toThrow(/Only the bot's admin/);
    expect(fake.calls).toEqual([]);

    const s = await spawn(t);
    const turn2 = await newTurn(t, 'UOTHER');
    await expect(sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: turn2, speakerId: 'UOTHER', subagentId: s.subagentId, text: 'also delete the tests' })).rejects.toThrow(/Only the bot's admin/);
    await expect(sub.cancelSubagent({ threadId: t, subagentId: s.subagentId, actor: 'UOTHER' })).rejects.toThrow(/Only the bot's admin/);
    expect((await sql<any[]>`select * from subagent_inbox where subagent_id = ${s.subagentId}`).length).toBe(0);
    expect((await runRow(s.runId)).cancelRequested).toBe(false);

    // Bulk cancels by others (a deleted thread root → 'system', old Stop-all buttons) leave coding agents running.
    expect(await sub.cancelThreadRuns(t, 'system')).toEqual([]);
    await sub.cancelCardRuns(s.cardId, 'UOTHER');
    expect((await runRow(s.runId)).cancelRequested).toBe(false);
    expect(fake.calls).not.toContain('cancelRun');
  });

  it('refuses when unconfigured', async () => {
    const t = await newThread();
    const s = await spawn(t);
    api.setCursorClientForTests(null);
    const { env } = await import('../../config.js');
    const key = env.CURSOR_API_KEY;
    (env as any).CURSOR_API_KEY = undefined;
    try {
      const turnId = await newTurn(t);
      await expect(agents.spawnCodingAgent({ threadId: t, turnId, ownerId: 'UADMIN', title: 'x', instructions: 'y' })).rejects.toThrow(/aren't set up/);
      await expect(sub.messageSubagent({ threadId: t, turnKind: 'user', turnId, speakerId: 'UADMIN', subagentId: s.subagentId, text: 'more' })).rejects.toThrow(/aren't set up/);
      await expect(sub.cancelSubagent({ threadId: t, subagentId: s.subagentId, actor: 'UADMIN' })).rejects.toThrow(/aren't set up/);
      // A run left over from when it was configured is failed by the poller instead of hanging.
      await poll(s.runId);
      expect(await runRow(s.runId)).toMatchObject({ status: 'error', error: 'Coding agents are no longer configured on this bot' });
    } finally {
      (env as any).CURSOR_API_KEY = key;
    }
  });

  it('steer while running is queued and sent as a follow-up run when the current run finishes', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'RUNNING' });
    await poll(s.runId);

    const turn2 = await newTurn(t);
    const m = await sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: turn2, speakerId: 'UADMIN', subagentId: s.subagentId, text: 'also accept "tmw"', note: 'also tmw' });
    expect(m).toMatchObject({ mode: 'steered', runId: s.runId, queued: true, note: 'next: also tmw' });
    expect((await runRow(s.runId)).steerNotes).toEqual(['next: also tmw']);
    expect(fake.calls).not.toContain('createRun'); // never sent mid-run (Cursor would answer 409 agent_busy)

    fake.set(agentId, { status: 'FINISHED', result: 'first pass', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId);
    let run = await runRow(s.runId);
    expect(run.status).toBe('running'); // continues with the follow-up instead of finishing
    expect(run.details).toBe('Sending the follow-up to Cursor…');
    const a = fake.agents.get(agentId)!;
    expect(a.runs).toHaveLength(2);
    expect(a.prompts[1]).toContain('<follow_up>\nalso accept "tmw"\n</follow_up>');
    expect(a.prompts[1]).toContain('.github/workflows/');
    const cr = (await sql<any[]>`select * from cursor_runs where run_id = ${s.runId}`)[0];
    expect(cr).toMatchObject({ cursorRunId: a.runs[1]!.id, followUps: 1 });
    expect((await sql<any[]>`select * from subagent_inbox where subagent_id = ${s.subagentId} and consumed_at is null`).length).toBe(0);
    expect(await synthTurns(s.cardId)).toHaveLength(0);

    fake.set(agentId, { status: 'RUNNING' });
    await poll(s.runId);
    expect((await runRow(s.runId)).details).toBe('Coding in Cursor (follow-up)…');
    fake.set(agentId, { status: 'FINISHED', result: 'tmw too', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId);
    run = await runRow(s.runId);
    expect(run.status).toBe('complete');
    expect(run.result).toContain('tmw too');
    expect(await synthTurns(s.cardId)).toHaveLength(1);
  });

  it('message_subagent on an idle coding agent resumes it: a new run backed by a Cursor follow-up', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'FINISHED', result: 'v1', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId);
    expect((await subRow(s.subagentId)).status).toBe('idle');

    const turn2 = await newTurn(t);
    const m = await sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: turn2, speakerId: 'UADMIN', subagentId: s.subagentId, text: 'rename the helper to parseWhen' });
    expect(m.mode).toBe('resumed');
    expect(m.cardId).not.toBe(s.cardId);
    const run = await runRow(m.runId);
    expect(run).toMatchObject({ status: 'running', isResume: true, instructions: 'rename the helper to parseWhen' });
    expect(fake.agents.get(agentId)!.prompts[1]).toContain('rename the helper to parseWhen');
    expect((await subRow(s.subagentId)).status).toBe('running');
    // The PR from before is already on the card row.
    expect(run.sources.map((x: any) => x.url)).toContain(PR);

    fake.set(agentId, { status: 'FINISHED', result: 'renamed', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(m.runId);
    expect(await runRow(m.runId)).toMatchObject({ status: 'complete', output: 'Opened PR #42' });
    expect(await synthTurns(m.cardId!)).toHaveLength(1);

    // An archived Cursor agent can't be resumed: clear error, nothing left behind.
    fake.agents.get(agentId)!.agent.status = 'ARCHIVED';
    const turn3 = await newTurn(t);
    await expect(sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: turn3, speakerId: 'UADMIN', subagentId: s.subagentId, text: 'more' })).rejects.toThrow(/archived or expired/);
    expect((await subRow(s.subagentId)).status).toBe('idle');
    expect((await sql<any[]>`select count(*)::int as n from runs where subagent_id = ${s.subagentId}`)[0].n).toBe(2);
  });

  it('cancel_subagent by the admin stops the Cursor run right away', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'RUNNING' });
    const msg = await sub.cancelSubagent({ threadId: t, subagentId: s.subagentId, actor: 'UADMIN' });
    expect(msg).toMatch(/Cancellation requested/);
    expect(fake.calls).toContain('cancelRun');
    expect(fake.latest(agentId).status).toBe('CANCELLED');
    expect((await runRow(s.runId)).status).toBe('cancelled');
    expect((await subRow(s.subagentId)).status).toBe('cancelled');
    expect(await synthTurns(s.cardId)).toHaveLength(1);
  });

  it('ERROR / EXPIRED / cancelled elsewhere → error runs, reported honestly', async () => {
    for (const [status, expected] of [
      ['ERROR', /^Cursor run error: Tests failed to install/],
      ['EXPIRED', /^Cursor run expired$/],
      ['CANCELLED', /^Cancelled in Cursor$/],
    ] as const) {
      fake = new FakeCursor();
      api.setCursorClientForTests(fake);
      const t = await newThread();
      const s = await spawn(t);
      fake.set(fake.only(), { status, result: status === 'ERROR' ? 'Tests failed to install' : undefined });
      await poll(s.runId);
      const run = await runRow(s.runId);
      expect(run.status).toBe('error');
      expect(run.error).toMatch(expected);
      expect(await synthTurns(s.cardId)).toHaveLength(1);
    }
  });

  it('at most limits.cursorMaxActive coding agents run at once', async () => {
    const { limits } = await import('../../config.js');
    const t = await newThread();
    for (let i = 0; i < limits.cursorMaxActive; i++) await spawn(t);
    await expect(spawn(t)).rejects.toThrow(/coding agents are already running/);
    expect(fake.agents.size).toBe(limits.cursorMaxActive);
  });

  // Regression (review #9): concurrent launches can't both take the last slot.
  it('the cursorMaxActive cap holds under concurrent launches', async () => {
    const { limits } = await import('../../config.js');
    const t = await newThread();
    for (let i = 0; i < limits.cursorMaxActive - 1; i++) await spawn(t);
    const results = await Promise.allSettled([1, 2, 3].map(async () => spawn(await newThread())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fake.agents.size).toBe(limits.cursorMaxActive);
  });

  it('a failed launch leaves nothing behind and tells the model', async () => {
    const t = await newThread();
    const { CursorApiError } = await import('./api.js');
    fake.failCreate = new CursorApiError(403, 'repository_access', 'Cursor API 403 repository_access: no access');
    const turnId = await newTurn(t);
    await expect(agents.spawnCodingAgent({ threadId: t, turnId, ownerId: 'UADMIN', title: 'x', instructions: 'y' })).rejects.toThrow(/Couldn't start the coding agent: .*repository_access/);
    expect((await sql<any[]>`select count(*)::int as n from subagents where thread_id = ${t}`)[0].n).toBe(0);
  });

  it('launch is idempotent: a retried create with the same agent id reuses the agent', async () => {
    const t = await newThread();
    const { CursorApiError } = await import('./api.js');
    // First attempt: a network error after Cursor already created the agent; the retry gets 409 agent_id_conflict.
    const orig = fake.createAgent.bind(fake);
    let first = true;
    fake.createAgent = async (input) => {
      const r = await orig(input);
      if (first) {
        first = false;
        throw new CursorApiError(0, 'network_error', 'timeout');
      }
      return r;
    };
    const s = await spawn(t);
    expect(fake.agents.size).toBe(1);
    const cr = (await sql<any[]>`select * from cursor_runs where run_id = ${s.runId}`)[0];
    expect(cr.cursorRunId).toBe(fake.latest(fake.only()).id);
  });

  it('exactly-once: two concurrent pollers handle a finished run once', async () => {
    const t = await newThread();
    const s = await spawn(t);
    fake.set(fake.only(), { status: 'FINISHED', result: 'done', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    fake.delayMs = 50;
    fake.calls = [];
    await sql`update cursor_runs set next_poll_at = now() where run_id = ${s.runId}`;
    const counts = await Promise.all([agents.pollCursorRuns({ runId: s.runId }), agents.pollCursorRuns({ runId: s.runId }), agents.pollCursorRuns({ runId: s.runId })]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(fake.calls.filter((c) => c === 'getRun')).toHaveLength(1);
    expect(await synthTurns(s.cardId)).toHaveLength(1);
    const finished = await sql<any[]>`select * from thread_events where thread_id = ${t} and type = 'run_finished'`;
    expect(finished).toHaveLength(1);
  });

  it('an expired lease is taken over; a live one is not', async () => {
    const t = await newThread();
    const s = await spawn(t);
    fake.set(fake.only(), { status: 'RUNNING' });
    await sql`update cursor_runs set next_poll_at = now(), claim_id = gen_random_uuid(), claimed_until = now() + interval '1 minute' where run_id = ${s.runId}`;
    expect(await agents.pollCursorRuns({ runId: s.runId })).toBe(0);
    await sql`update cursor_runs set claimed_until = now() - interval '1 second' where run_id = ${s.runId}`;
    expect(await agents.pollCursorRuns({ runId: s.runId })).toBe(1);
    expect((await sql<any[]>`select claim_id from cursor_runs where run_id = ${s.runId}`)[0].claimId).toBeNull();
  });

  it('the stale-heartbeat sweeper and the 10-min subagent limit never kill a coding agent; its own 3h timeout does', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'RUNNING' });
    await sql`update runs set heartbeat_at = now() - interval '2 hours', started_at = now() - interval '2 hours' where id = ${s.runId}`;
    await maint.sweepStaleRuns();
    expect((await runRow(s.runId)).status).toBe('running');
    await poll(s.runId);
    expect((await runRow(s.runId)).status).toBe('running');

    await sql`update runs set started_at = now() - interval '3 hours 1 minute' where id = ${s.runId}`;
    await poll(s.runId);
    expect(fake.latest(agentId).status).toBe('CANCELLED');
    expect(await runRow(s.runId)).toMatchObject({ status: 'error', error: 'Timed out after 3h (the Cursor run was cancelled)' });
  });

  it('transient API errors back off; a vanished agent fails the run', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    const { CursorApiError } = await import('./api.js');
    const orig = fake.getRun.bind(fake);
    fake.getRun = async () => {
      throw new CursorApiError(429, 'rate_limit_exceeded', 'slow', 90_000);
    };
    await poll(s.runId);
    let cr = (await sql<any[]>`select * from cursor_runs where run_id = ${s.runId}`)[0];
    expect(cr.pollErrors).toBe(1);
    expect(cr.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 80_000);
    expect((await runRow(s.runId)).status).toBe('running');

    fake.getRun = orig;
    fake.set(agentId, { status: 'RUNNING' });
    await poll(s.runId);
    cr = (await sql<any[]>`select * from cursor_runs where run_id = ${s.runId}`)[0];
    expect(cr.pollErrors).toBe(0);

    fake.agents.delete(agentId);
    await poll(s.runId);
    expect((await runRow(s.runId)).status).toBe('error');
    expect((await runRow(s.runId)).error).toMatch(/Cursor agent gone/);
  });

  // Regression (review #1): a steer queued on a running agent, Cursor finishing, then a cancel used to make finishRun
  // answer 'inbox' forever: the run was re-polled endlessly (Cursor + GitHub calls), never synthesized and held a slot.
  it('steer queued, Cursor finishes, then cancel → the run ends (no endless re-polling)', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'RUNNING' });
    await poll(s.runId);
    const turn2 = await newTurn(t);
    await sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: turn2, speakerId: 'UADMIN', subagentId: s.subagentId, text: 'also add tests' });
    fake.set(agentId, { status: 'FINISHED', result: 'done', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', branch: 'b', prUrl: PR }] } });
    await sub.cancelSubagent({ threadId: t, subagentId: s.subagentId, actor: 'UADMIN' });
    for (let i = 0; i < 5; i++) await poll(s.runId);
    const run = await runRow(s.runId);
    expect(run.status).not.toBe('running');
    expect(run.result).toContain(PR); // Cursor did finish: the PR is still reported
    expect(await sql`select * from subagent_inbox where subagent_id = ${s.subagentId} and consumed_at is null`).toHaveLength(0);
    expect(fake.calls.filter((c) => c === 'getRun').length).toBeLessThanOrEqual(2);
    expect(fake.calls).not.toContain('createRun'); // the cancelled steer is never sent
    expect(await synthTurns(s.cardId)).toHaveLength(1);
  });

  it('the poller ends a cancel-requested run even with unseen steers left in the inbox', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    // Bypass cancelSubagent (which consumes the inbox): the poller itself must not loop.
    await sql`update runs set cancel_requested = true where id = ${s.runId}`;
    await sql`insert into subagent_inbox (subagent_id, text) values (${s.subagentId}, 'late steer')`;
    fake.set(agentId, { status: 'FINISHED', result: 'done', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId);
    expect((await runRow(s.runId)).status).toBe('complete');
    expect(await poll(s.runId)).toBe(0);
    expect(fake.calls).not.toContain('createRun');
    expect(await synthTurns(s.cardId)).toHaveLength(1);
  });

  it('finishing is deferred for fresh steers only a bounded number of times', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'FINISHED', result: 'done' });
    const [row] = await sql<{ id: number }[]>`insert into subagent_inbox (subagent_id, text) values (${s.subagentId}, 'steer') returning id::int as id`;
    // Another transaction holds the steer (so the poller can't take it as a follow-up) while it keeps showing as unseen.
    const lock = await sql.reserve();
    await lock`begin`;
    await lock`select id from subagent_inbox where id = ${row!.id} for update`;
    try {
      // A deferred run is due again at once, so one poll call retries it until the bound, then blocks on our lock
      // while dropping the steer.
      const polling = poll(s.runId);
      await sleep(300);
      expect((await runRow(s.runId)).status).toBe('running');
      expect((await sql<any[]>`select inbox_defers from cursor_runs where run_id = ${s.runId}`)[0].inboxDefers).toBe(2);
      await lock`rollback`;
      await polling;
    } finally {
      lock.release();
    }
    expect((await runRow(s.runId)).status).toBe('complete');
    expect(await sql`select * from subagent_inbox where subagent_id = ${s.subagentId} and consumed_at is null`).toHaveLength(0);
    expect(await synthTurns(s.cardId)).toHaveLength(1);
  });

  // Regression (review #6): a poller whose claim was taken over must not finish the run.
  it('a poller that lost its claim does not finish the run', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'FINISHED', result: 'done', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    const orig = fake.getRun.bind(fake);
    fake.getRun = async (a, r) => {
      // Our lease "ran out" mid-poll and another poller claimed the row.
      await sql`update cursor_runs set claim_id = gen_random_uuid() where run_id = ${s.runId}`;
      return orig(a, r);
    };
    await poll(s.runId);
    expect((await runRow(s.runId)).status).toBe('running');
    expect(await synthTurns(s.cardId)).toHaveLength(0);
    // The new holder's lease runs out too; the next poller finishes it.
    fake.getRun = orig;
    await sql`update cursor_runs set claimed_until = now() - interval '1 second' where run_id = ${s.runId}`;
    await poll(s.runId);
    expect((await runRow(s.runId)).status).toBe('complete');
    expect(await synthTurns(s.cardId)).toHaveLength(1);
  });

  // Regression (review #5): an ambiguous launch failure (timeout / 5xx) keeps the rows; the poller resolves it.
  it('ambiguous launch failure: rows kept, the poller adopts the agent if Cursor created it, else fails the run', async () => {
    const { CursorApiError } = await import('./api.js');
    const t = await newThread();
    const orig = fake.createAgent.bind(fake);
    fake.createAgent = async (input) => {
      await orig(input); // Cursor created it, but the answer is lost
      throw new CursorApiError(504, 'http_504', 'gateway timeout');
    };
    const s = await spawn(t);
    const agentId = fake.only();
    expect((await subRow(s.subagentId)).status).toBe('running');
    expect((await sql<any[]>`select cursor_run_id from cursor_runs where run_id = ${s.runId}`)[0].cursorRunId).toBeNull();
    fake.set(agentId, { status: 'RUNNING' });
    await poll(s.runId); // getAgent → adopt the latest run
    await poll(s.runId);
    expect((await sql<any[]>`select cursor_run_id, cursor_status from cursor_runs where run_id = ${s.runId}`)[0]).toMatchObject({
      cursorRunId: fake.latest(agentId).id,
      cursorStatus: 'RUNNING',
    });

    // Never created (network error on both attempts): kept until the poller gives up.
    fake = new FakeCursor();
    api.setCursorClientForTests(fake);
    fake.failCreate = new CursorApiError(0, 'network_error', 'timeout');
    const t2 = await newThread();
    const s2 = await spawn(t2);
    expect(fake.calls.filter((c) => c === 'createAgent')).toHaveLength(2);
    await poll(s2.runId);
    expect((await runRow(s2.runId)).status).toBe('running');
    await sql`update cursor_runs set created_at = now() - interval '3 minutes' where run_id = ${s2.runId}`;
    await poll(s2.runId);
    expect(await runRow(s2.runId)).toMatchObject({ status: 'error', error: 'The Cursor agent never started' });
  });

  it('ambiguous follow-up failure: the run is kept and resolved by the poller, never confused with the old run', async () => {
    const { CursorApiError } = await import('./api.js');
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'FINISHED', result: 'v1' });
    await poll(s.runId);
    const oldRunId = fake.latest(agentId).id;

    const orig = fake.createRun.bind(fake);
    fake.createRun = async (a, p) => {
      await orig(a, p);
      throw new CursorApiError(0, 'network_error', 'timeout');
    };
    const m = await sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: await newTurn(t), speakerId: 'UADMIN', subagentId: s.subagentId, text: 'more' });
    expect(m.mode).toBe('resumed');
    expect((await sql<any[]>`select cursor_run_id, after_run_id from cursor_runs where run_id = ${m.runId}`)[0]).toMatchObject({ cursorRunId: null, afterRunId: oldRunId });
    await poll(m.runId);
    const newRunId = fake.latest(agentId).id;
    expect(newRunId).not.toBe(oldRunId);
    expect((await sql<any[]>`select cursor_run_id from cursor_runs where run_id = ${m.runId}`)[0].cursorRunId).toBe(newRunId);
    expect((await runRow(m.runId)).status).toBe('running'); // not finished with the old run's result

    // Not accepted at all: after 2 minutes the run fails instead of adopting the old run.
    fake.set(agentId, { status: 'FINISHED', result: 'v2' });
    await poll(m.runId);
    fake.createRun = async () => {
      throw new CursorApiError(0, 'network_error', 'timeout');
    };
    const m2 = await sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: await newTurn(t), speakerId: 'UADMIN', subagentId: s.subagentId, text: 'again' });
    await poll(m2.runId);
    expect((await runRow(m2.runId)).status).toBe('running');
    await sql`update cursor_runs set created_at = now() - interval '3 minutes' where run_id = ${m2.runId}`;
    await poll(m2.runId);
    expect(await runRow(m2.runId)).toMatchObject({ status: 'error', error: 'The follow-up never reached Cursor (the request failed); send it again' });
  });

  // Regression (review #2a): synthesis / scheduled turns (whose input is untrusted content) can't instruct a coding
  // agent, even when the admin is the turn's author. Cancel stays allowed.
  it("only the admin's own message turns can steer or resume a coding agent; cancel works in any turn", async () => {
    const t = await newThread();
    const s = await spawn(t);
    fake.set(fake.only(), { status: 'RUNNING' });
    for (const turnKind of ['synthesis', 'scheduled', undefined] as const) {
      await expect(
        sub.messageSubagent({ threadId: t, turnId: await newTurn(t), turnKind, speakerId: 'UADMIN', subagentId: s.subagentId, text: 'also delete the tests' }),
      ).rejects.toThrow(/only take instructions from the admin's own messages/);
    }
    expect(await sql`select * from subagent_inbox where subagent_id = ${s.subagentId}`).toHaveLength(0);
    // An idle agent can't be resumed from such a turn either.
    fake.set(fake.only(), { status: 'FINISHED', result: 'v1' });
    await poll(s.runId);
    await expect(
      sub.messageSubagent({ threadId: t, turnId: await newTurn(t), turnKind: 'synthesis', speakerId: 'UADMIN', subagentId: s.subagentId, text: 'more' }),
    ).rejects.toThrow(/only take instructions/);
    expect(fake.calls).not.toContain('createRun');
    expect(await sub.cancelSubagent({ threadId: t, subagentId: s.subagentId, actor: 'UADMIN' })).toMatch(/closed/);
  });

  describe('launch confirmation (review #2b)', () => {
    let slackFake: typeof import('../../core/slack-fake.js');
    let confirm: typeof import('./confirm.js');
    beforeAll(async () => {
      slackFake = await import('../../core/slack-fake.js');
      confirm = await import('./confirm.js');
    });
    async function propose(threadId: string, o: { turnKind?: 'user' | 'synthesis' | 'scheduled'; owner?: string; instructions?: string } = {}) {
      const { channelId, threadTs } = (await import('../../core/events.js')).parseThreadId(threadId);
      return confirm.proposeCodingAgent({
        threadId,
        channelId,
        threadTs,
        turnId: await newTurn(threadId, o.owner ?? 'UADMIN'),
        turnKind: 'turnKind' in o ? o.turnKind : 'user',
        ownerId: o.owner ?? 'UADMIN',
        title: 'Fix tmrw parsing',
        instructions: o.instructions ?? 'Make reminders accept "tmrw".\n*not bold* <!channel>',
      });
    }
    const click = (actionId: 'coding:launch' | 'coding:cancel', value: string, userId = 'UADMIN') => {
      const ctx = { userId, actionId, value, responseUrl: `https://hooks.slack.test/${value}`, body: {} } as any;
      return actionId === 'coding:launch' ? confirm.handleCodingLaunch(ctx) : confirm.handleCodingCancel(ctx);
    };
    const responseCalls = async (value: string) =>
      (await slackFake.fakeCalls()).filter((c) => c.method === 'response_url' && c.args.url === `https://hooks.slack.test/${value}`);
    const responses = async (value: string) => (await responseCalls(value)).filter((c) => !c.args.delete_original).map((c) => c.args.text as string);
    const pendingRow = async (id: string) => (await sql<any[]>`select * from pending_coding_agents where id = ${id}`)[0];
    const outcomeTurns = (pendingId: string) =>
      sql<any[]>`select t.*, i.input from scheduled_turn_inputs i join turns t on t.id = i.turn_id where i.source = 'coding_launch' and i.source_ref = ${pendingId}`;

    it('spawn_coding_agent only proposes: an ephemeral preview with the exact task, nothing sent to Cursor', async () => {
      const t = await newThread();
      const n = (await slackFake.fakeCalls()).length;
      const p = await propose(t);
      expect(p.reused).toBe(false);
      expect(fake.calls).toEqual([]);
      expect(await sql`select * from subagents where thread_id = ${t}`).toHaveLength(0);
      expect(await pendingRow(p.pendingId)).toMatchObject({ status: 'pending', ownerId: 'UADMIN', title: 'Fix tmrw parsing' });
      const preview = (await slackFake.fakeCalls()).slice(n).find((c) => c.method === 'chat.postEphemeral');
      expect(preview?.args).toMatchObject({ user: 'UADMIN', thread_ts: t.split(':')[1] });
      const blocks = JSON.stringify(preview!.args.blocks);
      expect(blocks).toContain(JSON.stringify('Make reminders accept "tmrw".\n*not bold* <!channel>').slice(1, -1)); // verbatim, plain_text
      expect(blocks).toContain('"action_id":"coding:launch"');
      // The same proposal again (model retry) reuses it.
      expect((await propose(t)).pendingId).toBe(p.pendingId);
    });

    it('refuses non-user turns and non-admins', async () => {
      const t = await newThread();
      await expect(propose(t, { turnKind: 'synthesis' })).rejects.toThrow(/only take instructions/);
      await expect(propose(t, { turnKind: 'scheduled' })).rejects.toThrow(/only take instructions/);
      await expect(propose(t, { turnKind: undefined })).rejects.toThrow(/only take instructions/);
      await expect(propose(t, { owner: 'UOTHER' })).rejects.toThrow(/Only the bot's admin/);
      await expect(propose(t, { instructions: 'x'.repeat(20_000) })).rejects.toThrow(/too long/);
      expect(await sql`select * from pending_coding_agents where thread_id = ${t}`).toHaveLength(0);
    });

    it('only the admin pressing Launch starts it, once; it gets its own plan card', async () => {
      const t = await newThread();
      const p = await propose(t);
      await click('coding:launch', p.pendingId, 'UOTHER');
      expect(await responses(p.pendingId)).toEqual(["Only the bot's admin can launch or cancel this."]);
      expect(fake.calls).toEqual([]);

      const n = (await slackFake.fakeCalls()).length;
      await Promise.all([click('coding:launch', p.pendingId), click('coding:launch', p.pendingId)]);
      expect(fake.agents.size).toBe(1);
      expect(fake.only()).toBe(`bc-${p.pendingId}`);
      const row = await pendingRow(p.pendingId);
      expect(row.status).toBe('launched');
      const sa = await subRow(row.subagentId);
      expect(sa).toMatchObject({ kind: 'cursor', status: 'running', threadId: t });
      const [run] = await sql<any[]>`select * from runs where subagent_id = ${row.subagentId}`;
      expect(run.turnId).toBeNull();
      expect(run.instructions).toBe('Make reminders accept "tmrw".\n*not bold* <!channel>');
      const [card] = await sql<any[]>`select * from cards where id = ${run.cardId}`;
      expect(card).toMatchObject({ threadId: t, turnId: null });
      expect(card.messageTs).toBeTruthy(); // posted as its own message in the thread
      const posted = (await slackFake.fakeCalls()).slice(n).filter((c) => c.method === 'chat.postMessage' && c.args.thread_ts === t.split(':')[1]);
      expect(posted).toHaveLength(1);
      // The plan card is the feedback: the preview is deleted (no "Launched ✓" left behind), and no outcome turn.
      expect((await responseCalls(p.pendingId)).filter((c) => c.args.delete_original === true)).toHaveLength(1);
      const texts = await responses(p.pendingId);
      expect(texts.some((x) => x.startsWith('Launched ✓'))).toBe(false);
      expect(texts.some((x) => x === 'Already launched.' || x === 'Launching…')).toBe(true);
      expect(await outcomeTurns(p.pendingId)).toHaveLength(0);

      // It finishes → synthesis for the admin on that card.
      fake.set(fake.only(), { status: 'FINISHED', result: 'done', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
      await poll(run.id);
      const turns = await synthTurns(Number(run.cardId));
      expect(turns).toHaveLength(1);
      expect(turns[0].authorId).toBe('UADMIN');
    });

    it('cancel, expiry and stale clicks', async () => {
      const t = await newThread();
      const p = await propose(t);
      await click('coding:cancel', p.pendingId);
      expect((await pendingRow(p.pendingId)).status).toBe('cancelled');
      await click('coding:launch', p.pendingId);
      expect((await responses(p.pendingId)).at(-1)).toBe('Cancelled. Nothing was started.');

      const p2 = await propose(await newThread());
      await sql`update pending_coding_agents set expires_at = now() - interval '1 second' where id = ${p2.pendingId}`;
      await click('coding:launch', p2.pendingId);
      expect((await responses(p2.pendingId)).at(-1)).toMatch(/expired/);
      await confirm.expirePendingLaunches();
      expect((await pendingRow(p2.pendingId)).status).toBe('expired');
      expect(fake.calls).toEqual([]);
    });

    it('Cancel, a failed launch and expiry each start exactly one outcome turn for the admin', async () => {
      const t1 = await newThread();
      const p1 = await propose(t1);
      await Promise.all([click('coding:cancel', p1.pendingId), click('coding:cancel', p1.pendingId)]);
      await confirm.expirePendingLaunches();
      const c = await outcomeTurns(p1.pendingId);
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ kind: 'scheduled', authorId: 'UADMIN', isMention: true, threadId: t1 });
      expect(c[0].input).toContain('status="cancelled"');
      expect(c[0].input).toContain('Fix tmrw parsing');
      expect(c[0].input).toMatch(/^System notice \(not a message from <@UADMIN>\)/m);

      const t2 = await newThread();
      const p2 = await propose(t2);
      const { CursorApiError } = await import('./api.js');
      fake.failCreate = new CursorApiError(403, 'repository_access', 'Cursor API 403 repository_access: no access');
      try {
        await click('coding:launch', p2.pendingId);
      } finally {
        fake.failCreate = null;
      }
      expect((await pendingRow(p2.pendingId)).status).toBe('failed');
      expect((await responses(p2.pendingId)).at(-1)).toMatch(/^Not launched/);
      const f = await outcomeTurns(p2.pendingId);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ isMention: true });
      expect(f[0].input).toContain('status="failed"');

      // Expiry racing a click: one outcome, nothing launched; old expiries get none.
      const t3 = await newThread();
      const p3 = await propose(t3);
      const p4 = await propose(await newThread());
      await sql`update pending_coding_agents set expires_at = now() - interval '1 second' where id = ${p3.pendingId}`;
      await sql`update pending_coding_agents set expires_at = now() - interval '2 hours' where id = ${p4.pendingId}`;
      const creates = fake.calls.filter((x) => x === 'createAgent').length;
      await Promise.all([click('coding:launch', p3.pendingId), click('coding:cancel', p3.pendingId), confirm.expirePendingLaunches(), confirm.expirePendingLaunches()]);
      expect((await pendingRow(p3.pendingId)).status).toBe('expired');
      const e = await outcomeTurns(p3.pendingId);
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({ isMention: false, threadId: t3 });
      expect(e[0].input).toContain('status="expired"');
      expect((await pendingRow(p4.pendingId)).status).toBe('expired');
      expect(await outcomeTurns(p4.pendingId)).toHaveLength(0);
      expect(fake.calls.filter((x) => x === 'createAgent')).toHaveLength(creates);
    });

    it('no outcome turn in a disabled channel or for a gone thread; the launch still resolves', async () => {
      const state = await import('../../features/state.js');
      const p1 = await propose(await newThread());
      await sql`update pending_coding_agents set expires_at = now() - interval '1 second' where id = ${p1.pendingId}`;
      // The admin bypasses pause and suspension (guard.evaluateEntry), not a disabled channel.
      const ch = (await import('../../core/events.js')).parseThreadId((await pendingRow(p1.pendingId)).threadId).channelId;
      await state.setChannelDisabled(ch, true);
      try {
        await confirm.expirePendingLaunches();
      } finally {
        await state.setChannelDisabled(ch, false);
      }
      expect((await pendingRow(p1.pendingId)).status).toBe('expired');
      expect(await outcomeTurns(p1.pendingId)).toHaveLength(0);

      const t2 = await newThread();
      const p2 = await propose(t2);
      await sql`update threads set root_deleted_at = now() where id = ${t2}`;
      await click('coding:cancel', p2.pendingId);
      expect((await pendingRow(p2.pendingId)).status).toBe('cancelled');
      expect(await outcomeTurns(p2.pendingId)).toHaveLength(0);
    });

    it('a DM session is suspended while the launch preview is pending and resumes on Launch', async () => {
      const channelId = `DCUR${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const dm = `${channelId}:1791000000.000100`;
      await sql`insert into threads (id, channel_id, thread_ts, is_dm) values (${dm}, ${channelId}, '1791000000.000100', true)`;
      threads.push(dm);
      const session = await import('../../pipeline/agent-session.js');
      const p = await propose(dm);
      expect(await session.finalSessionStatus(dm, 1)).toBe('suspended');
      await click('coding:launch', p.pendingId);
      expect((await pendingRow(p.pendingId)).status).toBe('launched');
      expect(await session.finalSessionStatus(dm, 1)).toBe('active');
      const statuses = (await slackFake.fakeCalls()).filter((c) => c.method === 'agents.sessions.setStatus' && c.args.channel_id === channelId).map((c) => c.args.status);
      expect(statuses).toEqual(['active']);
    });
  });

  // Regression (review #4): a deleted thread root used to orphan a running coding agent (not cancelled, but steer /
  // cancel / synthesis all pointed at the gone thread). It now moves to a DM thread with the admin.
  it('a deleted thread root moves a running coding agent to a DM with the admin', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.set(agentId, { status: 'RUNNING' });
    await poll(s.runId);
    await sql`update threads set root_deleted_at = now() where id = ${t}`;
    expect(await sub.cancelThreadRuns(t, 'system')).toEqual([]); // what intake does first: coding agents untouched
    const moved = await agents.rehomeCodingAgents(t);
    expect(moved).toEqual([s.subagentId]);
    const sa = await subRow(s.subagentId);
    expect(sa.threadId).toMatch(/^DUADMIN:/);
    const dmThread: string = sa.threadId;
    threads.push(dmThread);
    const run = await runRow(s.runId);
    expect(run.threadId).toBe(dmThread);
    expect(Number(run.cardId)).not.toBe(s.cardId);
    const [card] = await sql<any[]>`select * from cards where id = ${run.cardId}`;
    expect(card).toMatchObject({ threadId: dmThread, turnId: null });
    expect(card.messageTs).toBeTruthy();
    // Idempotent: a second call finds nothing left in the old thread.
    expect(await agents.rehomeCodingAgents(t)).toEqual([]);

    // Steering works from the DM thread (and no longer from the gone one).
    await expect(sub.messageSubagent({ threadId: t, turnKind: 'user', turnId: await newTurn(t), speakerId: 'UADMIN', subagentId: s.subagentId, text: 'x' })).rejects.toThrow(/No subagent/);
    const m = await sub.messageSubagent({ threadId: dmThread, turnKind: 'user', turnId: await newTurn(dmThread), speakerId: 'UADMIN', subagentId: s.subagentId, text: 'also add tests' });
    expect(m).toMatchObject({ mode: 'steered', runId: s.runId, queued: true });

    // The result's synthesis turn runs in the DM thread.
    fake.set(agentId, { status: 'FINISHED', result: 'done', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId); // sends the queued steer as a follow-up
    fake.set(agentId, { status: 'FINISHED', result: 'done 2', git: { branches: [{ repoUrl: 'github.com/ingoau/smasnug-ai-v3', prUrl: PR }] } });
    await poll(s.runId);
    expect((await runRow(s.runId)).status).toBe('complete');
    const turns = await synthTurns(Number(run.cardId));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ threadId: dmThread, authorId: 'UADMIN' });
    expect(await synthTurns(s.cardId)).toHaveLength(0);
  });

  // Regression (review #7): an agent that never yields a run is not polled forever.
  it('a launch whose run id never appears times out after cursorRunMaxMs', async () => {
    const t = await newThread();
    const s = await spawn(t);
    const agentId = fake.only();
    fake.agents.get(agentId)!.agent.latestRunId = undefined;
    await sql`update cursor_runs set cursor_run_id = null where run_id = ${s.runId}`;
    await poll(s.runId);
    expect((await runRow(s.runId)).status).toBe('running');
    await sql`update runs set started_at = now() - interval '3 hours 1 minute' where id = ${s.runId}`;
    await poll(s.runId);
    expect(await runRow(s.runId)).toMatchObject({ status: 'error', error: 'The Cursor agent never started a run' });
  });
});
