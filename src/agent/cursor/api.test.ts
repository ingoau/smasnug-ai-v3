import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});

const api = await import('./api.js');

function mockFetch(responses: { status?: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('Cursor API client', () => {
  it('creates an agent: POST /v1/agents with Bearer auth, repo, ref, autoCreatePR and the client-supplied id', async () => {
    const { fn, calls } = mockFetch([
      { status: 201, body: { agent: { id: 'bc-1', status: 'ACTIVE', url: 'https://cursor.com/agents/bc-1' }, run: { id: 'run-1', agentId: 'bc-1', status: 'CREATING' } } },
    ]);
    const c = api.createCursorClient({ apiKey: 'crsr_secret', baseUrl: 'https://api.example.test/', fetch: fn });
    const res = await c.createAgent({ agentId: 'bc-1', promptText: 'do it', name: 'Fix it', repoUrl: 'https://github.com/o/r', ref: 'main', model: 'composer-2' });
    expect(res.run.id).toBe('run-1');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/agents');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer crsr_secret');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      agentId: 'bc-1',
      prompt: { text: 'do it' },
      name: 'Fix it',
      model: { id: 'composer-2' },
      repos: [{ url: 'https://github.com/o/r', startingRef: 'main' }],
      autoCreatePR: true,
    });
  });

  it('omits model when unset (account default) and caps the name at 100 chars', () => {
    const body = api.buildCreateAgentBody({ agentId: 'bc-2', promptText: 'x', name: 'n'.repeat(150), repoUrl: 'https://github.com/o/r', ref: 'dev' });
    expect(body.model).toBeUndefined();
    expect((body.name as string).length).toBe(100);
    expect(body.repos).toEqual([{ url: 'https://github.com/o/r', startingRef: 'dev' }]);
  });

  it('reads runs, sends follow-ups, cancels, lists, me: paths and bodies', async () => {
    const { fn, calls } = mockFetch([
      { body: { id: 'run-1', agentId: 'bc-1', status: 'RUNNING' } },
      { status: 201, body: { run: { id: 'run-2', agentId: 'bc-1', status: 'CREATING' } } },
      { body: { id: 'run-2' } },
      { body: { items: [] } },
      { body: { apiKeyName: 'k', createdAt: 'x' } },
      { body: { id: 'bc-1', status: 'IDLE', latestRunId: 'run-2' } },
    ]);
    const c = api.createCursorClient({ apiKey: 'k', fetch: fn });
    expect((await c.getRun('bc-1', 'run-1')).status).toBe('RUNNING');
    expect((await c.createRun('bc-1', 'also this')).id).toBe('run-2');
    await c.cancelRun('bc-1', 'run-2');
    await c.listAgents(500);
    await c.me();
    expect((await c.getAgent('bc-1')).latestRunId).toBe('run-2');
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      'GET https://api.cursor.com/v1/agents/bc-1/runs/run-1',
      'POST https://api.cursor.com/v1/agents/bc-1/runs',
      'POST https://api.cursor.com/v1/agents/bc-1/runs/run-2/cancel',
      'GET https://api.cursor.com/v1/agents?limit=100',
      'GET https://api.cursor.com/v1/me',
      'GET https://api.cursor.com/v1/agents/bc-1',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ prompt: { text: 'also this' } });
  });

  it('maps API errors ({ error: { code, message } }) and marks transient ones', async () => {
    const { fn } = mockFetch([
      { status: 409, body: { error: { code: 'agent_busy', message: 'Agent is busy' } } },
      { status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'slow down' } }, headers: { 'retry-after': '60' } },
      { status: 404, body: { error: { code: 'agent_not_found', message: 'nope' } } },
    ]);
    const c = api.createCursorClient({ apiKey: 'k', fetch: fn });
    const e1 = await c.createRun('bc-1', 'x').catch((e) => e);
    expect(e1).toBeInstanceOf(api.CursorApiError);
    expect(e1).toMatchObject({ status: 409, code: 'agent_busy' });
    expect(e1.transient).toBe(false);
    const e2 = await c.getRun('bc-1', 'r').catch((e) => e);
    expect(e2).toMatchObject({ status: 429, code: 'rate_limit_exceeded', retryAfterMs: 60_000 });
    expect(e2.transient).toBe(true);
    const e3 = await c.getAgent('bc-1').catch((e) => e);
    expect(e3).toMatchObject({ status: 404, code: 'agent_not_found' });
  });

  it('network errors are transient and never echo the key', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const e = await api.createCursorClient({ apiKey: 'crsr_topsecret', fetch: fn }).getRun('a', 'b').catch((x) => x);
    expect(e).toMatchObject({ status: 0, code: 'network_error' });
    expect(e.transient).toBe(true);
    expect(String(e.message)).not.toContain('crsr_topsecret');
  });
});

describe('run status helpers', () => {
  it('active vs terminal', () => {
    expect(api.isRunActive('CREATING')).toBe(true);
    expect(api.isRunActive('RUNNING')).toBe(true);
    for (const s of ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']) expect(api.isRunActive(s)).toBe(false);
  });

  it('describes progress for the card', () => {
    expect(api.describeRunStatus('CREATING', 0)).toBe('Starting the Cursor agent…');
    expect(api.describeRunStatus('RUNNING', 0)).toBe('Coding in Cursor…');
    expect(api.describeRunStatus('RUNNING', 2)).toBe('Coding in Cursor (follow-up)…');
  });

  it('picks the PR of the configured repo from git.branches (repoUrl comes without the scheme)', () => {
    const run = {
      git: {
        branches: [
          { repoUrl: 'github.com/other/repo', branch: 'x', prUrl: 'https://github.com/other/repo/pull/1' },
          { repoUrl: 'github.com/IngoAU/smasnug-ai-v3', branch: 'cursor/fix-a1b2', prUrl: 'https://github.com/ingoau/smasnug-ai-v3/pull/42' },
        ],
      },
    };
    expect(api.pickBranch(run, 'https://github.com/ingoau/smasnug-ai-v3')).toMatchObject({ branch: 'cursor/fix-a1b2', prUrl: 'https://github.com/ingoau/smasnug-ai-v3/pull/42' });
    expect(api.pickBranch({ git: { branches: [{ repoUrl: 'github.com/o/r', branch: 'b' }] } }, 'https://github.com/o/r')).toEqual({ repoUrl: 'github.com/o/r', branch: 'b' });
    expect(api.pickBranch({}, 'https://github.com/o/r')).toBeNull();
  });

  it('parses GitHub PR URLs and spots CI paths', () => {
    expect(api.parseGithubPr('https://github.com/o/r/pull/12')).toEqual({ owner: 'o', repo: 'r', number: 12 });
    expect(api.parseGithubPr('https://github.com/o/r/pull/12/files')).toEqual({ owner: 'o', repo: 'r', number: 12 });
    expect(api.parseGithubPr('https://evil.test/o/r/pull/12')).toBeNull();
    expect(api.isCiPath('.github/workflows/container.yml')).toBe(true);
    expect(api.isCiPath('.github/actions/setup/action.yml')).toBe(true);
    expect(api.isCiPath('src/.github/workflows.ts')).toBe(false);
    expect(api.isCiPath('docs/design.md')).toBe(false);
    // Repo policy under .github/ and other CI systems (review #11).
    for (const p of ['.github/CODEOWNERS', '.github/dependabot.yml', '/.github/rulesets/main.json', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', '.travis.yml', 'azure-pipelines.yml', '.buildkite/pipeline.yml', 'bitbucket-pipelines.yml'])
      expect(api.isCiPath(p), p).toBe(true);
    for (const p of ['src/ci.ts', 'docs/github.md', 'src/codeowners.ts', 'packages/x/.gitlab-ci.yml.md']) expect(api.isCiPath(p), p).toBe(false);
  });
});

describe('prChangedFiles (GitHub REST)', () => {
  it('lists files (incl. rename sources) and pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts` }));
    const { fn, calls } = mockFetch([{ body: page1 }, { body: [{ filename: 'ci.yml', previous_filename: '.github/workflows/container.yml' }] }]);
    const res = await api.prChangedFiles('https://github.com/o/r/pull/7', 'https://github.com/O/R', fn);
    expect('files' in res && res.files.length).toBe(102);
    expect('files' in res && res.files.filter(api.isCiPath)).toEqual(['.github/workflows/container.yml']);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/pulls/7/files?per_page=100&page=1');
    expect(calls[1]!.url).toContain('page=2');
  });

  it('refuses PRs outside the configured repo and reports API errors', async () => {
    const { fn, calls } = mockFetch([{ status: 404, body: { message: 'Not Found' } }]);
    expect(await api.prChangedFiles('https://github.com/x/y/pull/1', 'https://github.com/o/r', fn)).toEqual({ error: 'the PR is not in the configured repository' });
    expect(calls).toHaveLength(0);
    expect(await api.prChangedFiles('https://github.com/o/r/pull/1', 'https://github.com/o/r', fn)).toEqual({ error: 'GitHub API 404' });
  });
});
