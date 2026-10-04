/**
 * Minimal client for Cursor's Cloud Agents API v1 (public beta). Only what coding agents need: create an agent, read a
 * run, start a follow-up run, cancel a run, read an agent, list agents and `GET /v1/me` (live test).
 *
 * Reference (verified 2026-10): https://cursor.com/docs/cloud-agent/api/endpoints (markdown:
 * https://cursor.com/docs/cloud-agent/api/endpoints.md, OpenAPI: https://cursor.com/docs-static/cloud-agents-openapi.yaml)
 * - Auth: `Authorization: Bearer <key>` (Basic also works), base URL https://api.cursor.com (https://cursor.com/docs/api.md#authentication).
 * - POST /v1/agents { prompt: { text }, model?: { id }, name?, repos: [{ url, startingRef }], autoCreatePR, agentId? }
 *   → { agent, run }. A client-supplied `agentId` ("bc-<uuid>") makes create idempotent: re-POSTing it returns
 *   `409 agent_id_conflict` instead of a duplicate.
 * - GET /v1/agents/{id} → agent { id, name, status: ACTIVE | IDLE | ARCHIVED, url, latestRunId, … }.
 * - GET /v1/agents/{id}/runs/{runId} → run { id, agentId, status: CREATING | RUNNING | FINISHED | ERROR | CANCELLED |
 *   EXPIRED, durationMs?, result? (final assistant text), git?: { branches: [{ repoUrl, branch?, prUrl? }] } }.
 *   `git` is per-agent state (the same on every run); `repoUrl` comes without the scheme.
 * - POST /v1/agents/{id}/runs { prompt: { text } } → { run }: a follow-up on the agent's conversation + workspace.
 *   Only one active run per agent: `409 agent_busy` while one is CREATING/RUNNING. There is no mid-run steering for
 *   cloud agents (the TypeScript SDK's `run.steer()` is "local runs only; cloud runs always resolve
 *   revert_to_followup", https://cursor.com/docs/sdk/typescript.md#steering-a-run-in-flight), so steers are queued and
 *   sent as a follow-up run once the current run ends (src/agent/cursor/agents.ts).
 * - POST /v1/agents/{id}/runs/{runId}/cancel → { id }; terminal (`CANCELLED`); `409 run_not_cancellable` if done.
 * - Errors: `{ error: { code, message } }` (codes like agent_busy, agent_archived, agent_not_found, run_not_found,
 *   rate_limit_exceeded, usage_limit_exceeded, repository_access…). Rate limits: "standard" (default 20 req/min per
 *   endpoint per key, https://cursor.com/docs/api.md#rate-limits); 429 on excess.
 * - Webhooks exist only on the legacy v0 API, and this bot has no public HTTP endpoint anyway: runs are polled.
 * The changed-file list of a PR is not exposed by this API; see `prChangedFiles` (GitHub REST) for the CI check.
 */
import { env, limits } from '../../config.js';

export type CursorRunStatus = 'CREATING' | 'RUNNING' | 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED';
export type CursorAgentStatus = 'ACTIVE' | 'IDLE' | 'ARCHIVED';

export interface CursorGitBranch {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
}

export interface CursorRun {
  id: string;
  agentId: string;
  status: CursorRunStatus;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  result?: string;
  git?: { branches?: CursorGitBranch[] };
}

export interface CursorAgent {
  id: string;
  name?: string;
  status: CursorAgentStatus;
  url?: string;
  latestRunId?: string;
  createdAt?: string;
}

export interface CreateAgentInput {
  agentId: string;
  promptText: string;
  name?: string;
  repoUrl: string;
  ref: string;
  model?: string;
}

/** The subset of the API the bot uses (the integration tests swap in an in-memory fake). */
export interface CursorClient {
  createAgent(input: CreateAgentInput): Promise<{ agent: CursorAgent; run: CursorRun }>;
  getAgent(agentId: string): Promise<CursorAgent>;
  getRun(agentId: string, runId: string): Promise<CursorRun>;
  createRun(agentId: string, promptText: string): Promise<CursorRun>;
  cancelRun(agentId: string, runId: string): Promise<void>;
  listAgents(limit?: number): Promise<{ items: CursorAgent[] }>;
  me(): Promise<{ apiKeyName: string }>;
}

export class CursorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'CursorApiError';
  }
  /** Worth retrying later (rate limit, server/network trouble) rather than failing the run. */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export const ACTIVE_RUN_STATUSES: ReadonlySet<CursorRunStatus> = new Set(['CREATING', 'RUNNING']);
export const isRunActive = (s: string) => ACTIVE_RUN_STATUSES.has(s as CursorRunStatus);

type Fetch = typeof fetch;

/** Request building (pure): method, path and JSON body for each call. */
export function buildCreateAgentBody(input: CreateAgentInput): Record<string, unknown> {
  return {
    agentId: input.agentId,
    prompt: { text: input.promptText },
    ...(input.name ? { name: input.name.slice(0, 100) } : {}),
    ...(input.model ? { model: { id: input.model } } : {}),
    repos: [{ url: input.repoUrl, startingRef: input.ref }],
    autoCreatePR: true,
  };
}

export function createCursorClient(opts: { apiKey: string; baseUrl?: string; fetch?: Fetch; timeoutMs?: number }): CursorClient {
  const base = (opts.baseUrl ?? 'https://api.cursor.com').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? limits.cursorApiTimeoutMs;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error / timeout: never include the request (it carries the key in a header, not the URL, but be safe).
      throw new CursorApiError(0, 'network_error', `Cursor API ${method} ${path} failed: ${(err as Error)?.name ?? 'error'}`);
    }
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = json?.error;
      const code = typeof e === 'object' && e?.code ? String(e.code) : typeof e === 'string' ? e : `http_${res.status}`;
      const msg = typeof e === 'object' && e?.message ? String(e.message) : (json?.message ?? text.slice(0, 200) ?? res.statusText);
      const ra = Number(res.headers.get('retry-after'));
      throw new CursorApiError(res.status, code, `Cursor API ${res.status} ${code}: ${msg}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
    }
    return json as T;
  }

  const enc = encodeURIComponent;
  return {
    createAgent: (input) => call('POST', '/v1/agents', buildCreateAgentBody(input)),
    getAgent: (agentId) => call('GET', `/v1/agents/${enc(agentId)}`),
    getRun: (agentId, runId) => call('GET', `/v1/agents/${enc(agentId)}/runs/${enc(runId)}`),
    createRun: async (agentId, promptText) =>
      (await call<{ run: CursorRun }>('POST', `/v1/agents/${enc(agentId)}/runs`, { prompt: { text: promptText } })).run,
    cancelRun: async (agentId, runId) => {
      await call('POST', `/v1/agents/${enc(agentId)}/runs/${enc(runId)}/cancel`);
    },
    listAgents: (limit = 5) => call('GET', `/v1/agents?limit=${Math.max(1, Math.min(100, limit))}`),
    me: () => call('GET', '/v1/me'),
  };
}

// ---------- configured client (env) ----------

let override: CursorClient | null = null;
let fromEnv: CursorClient | null = null;

/** The configured client, or null when coding agents are off. */
export function cursorClient(): CursorClient | null {
  if (override) return override;
  if (!env.CURSOR_API_KEY) return null;
  fromEnv ??= createCursorClient({ apiKey: env.CURSOR_API_KEY, baseUrl: env.CURSOR_API_URL });
  return fromEnv;
}

/** Tests: swap in a fake API (null restores the env client). */
export function setCursorClientForTests(c: CursorClient | null) {
  override = c;
}

// ---------- results ----------

/** "https://github.com/O/R" / "github.com/o/r.git" → "github.com/o/r" (lowercase), for comparing repo URLs. */
export function normalizeRepo(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** The PR (and branch) for our repo from a run's `git` snapshot; falls back to any branch with a PR. */
export function pickBranch(run: Pick<CursorRun, 'git'>, repoUrl: string): CursorGitBranch | null {
  const branches = run.git?.branches ?? [];
  const want = normalizeRepo(repoUrl);
  const ours = branches.filter((b) => normalizeRepo(b.repoUrl ?? '') === want);
  return ours.find((b) => b.prUrl) ?? branches.find((b) => b.prUrl) ?? ours[0] ?? branches[0] ?? null;
}

/** Card details for an active Cursor run. */
export function describeRunStatus(status: string, followUps: number): string {
  if (status === 'CREATING') return followUps ? 'Sending the follow-up to Cursor…' : 'Starting the Cursor agent…';
  if (status === 'RUNNING') return followUps ? 'Coding in Cursor (follow-up)…' : 'Coding in Cursor…';
  return `Cursor: ${status.toLowerCase()}`;
}

// ---------- CI-config check (GitHub REST) ----------

/** Paths a coding agent must never touch (CI config). */
export function isCiPath(path: string): boolean {
  const p = path.replace(/^\/+/, '');
  return p.startsWith('.github/workflows/') || p.startsWith('.github/actions/');
}

/** "https://github.com/o/r/pull/12" → { owner, repo, number } (only github.com PRs). */
export function parseGithubPr(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

/**
 * The PR's changed files via GitHub REST "List pull requests files"
 * (https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files; 100 per page, at most 3000 files). Only for a
 * PR in the configured repo (the URL comes from Cursor). Public repos need no token (60 req/h unauthenticated).
 */
export async function prChangedFiles(prUrl: string, repoUrl: string, fetchFn: Fetch = fetch): Promise<{ files: string[] } | { error: string }> {
  const pr = parseGithubPr(prUrl);
  if (!pr) return { error: 'not a github.com pull request URL' };
  if (normalizeRepo(`github.com/${pr.owner}/${pr.repo}`) !== normalizeRepo(repoUrl)) return { error: 'the PR is not in the configured repository' };
  const files: string[] = [];
  for (let page = 1; page <= 5; page++) {
    let res: Response;
    try {
      res = await fetchFn(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'smasnug-ai',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(env.CURSOR_GITHUB_TOKEN ? { Authorization: `Bearer ${env.CURSOR_GITHUB_TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { error: `GitHub request failed (${(err as Error)?.name ?? 'error'})` };
    }
    if (!res.ok) return { error: `GitHub API ${res.status}` };
    const batch = (await res.json().catch(() => null)) as { filename?: string; previous_filename?: string }[] | null;
    if (!Array.isArray(batch)) return { error: 'unexpected GitHub response' };
    for (const f of batch) {
      if (f.filename) files.push(f.filename);
      if (f.previous_filename) files.push(f.previous_filename); // a rename out of .github/workflows/ counts too
    }
    if (batch.length < 100) break;
  }
  return { files };
}
