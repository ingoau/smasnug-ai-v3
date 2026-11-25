/**
 * Vault integration: store, tools, approvals (owner-only clicks, grants, wait + outcome modes) against the test
 * Postgres/Redis with SLACK_FAKE=1. Run: INTEGRATION=1 pnpm vitest run src/features/vault/vault.int.test.ts
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.VAULT_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const uid = () => `UV${rand()}`;

describe.skipIf(!INTEGRATION)('vault integration', () => {
  let sql: typeof import('../../db/index.js').sql;
  let store: typeof import('./store.js');
  let approvals: typeof import('./approvals.js');
  let toolsFor: typeof import('../../core/tools.js').toolsFor;
  let fakeCalls: typeof import('../../core/slack-fake.js').fakeCalls;

  const threadId = `CVAULT${rand()}:1700000000.000200`;
  const [channelId, threadTs] = threadId.split(':') as [string, string];
  const exec = (t: any, input: object) => t.execute(input, { toolCallId: 'tc', messages: [] });
  const frontCtx = (speakerId: string, kind: 'user' | 'scheduled' = 'user') => ({
    threadId,
    channelId,
    threadTs,
    speakerId,
    turnId: 1,
    extras: { agentTurn: { turn: { kind, authorId: speakerId, ephemeral: false } } },
  });
  const childCtx = (ownerId: string) => ({ threadId, channelId, threadTs, speakerId: ownerId, subagentId: randomBytes(16).toString('hex'), runId: 1, extras: {} });
  const click = (userId: string, actionId: string, value: string) => ({ userId, actionId, value, responseUrl: `https://hooks.fake/${rand()}`, body: {} });

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    const { migrate } = await import('../../db/migrate.js');
    await migrate();
    ({ fakeCalls } = await import('../../core/slack-fake.js'));
    store = await import('./store.js');
    approvals = await import('./approvals.js');
    ({ toolsFor } = await import('../../core/tools.js'));
    const { registerVaultTools } = await import('./tools.js');
    registerVaultTools();
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channelId}, ${threadTs}) on conflict do nothing`;
  });

  it('saves, lists and never shows secrets', async () => {
    const owner = uid();
    const t = toolsFor('front', frontCtx(owner) as any);
    const saved = await exec(t.save_credential, { name: 'GitHub', type: 'api_key', website: 'api.github.com', value: 'ghp_secretvalue1' });
    expect(saved).toContain('Saved "github"');
    expect(await exec(t.save_credential, { name: 'github', type: 'api_key', value: 'x' })).toContain('already exists');
    const listed = await exec(t.list_credentials, {});
    expect(listed).toContain('github');
    expect(listed).not.toContain('ghp_secretvalue1');
    const c = (await store.getCredential(owner, 'github'))!;
    expect((await store.revealSecret({ ...c, kind: 'token' })).value).toBe('ghp_secretvalue1');
    // Another user can't see it.
    expect(await exec(toolsFor('front', frontCtx(uid()) as any).list_credentials, {})).toContain('No credentials');
  });

  it('refuses non-user turns', async () => {
    const owner = uid();
    const t = toolsFor('front', frontCtx(owner, 'scheduled') as any);
    expect(await exec(t.list_credentials, {})).toContain("owner's own message");
  });

  it('only the owner can approve; window grants skip the card in that thread only', async () => {
    const owner = uid();
    const c = await store.saveCredential({ ownerId: owner, name: 'k', kind: 'token', meta: { domains: ['example.com'] }, secret: { value: 'v' } });
    const req = { ownerId: owner, threadId, kind: 'credential_fetch', mode: 'wait' as const, credentialId: c.id, grantKey: `cred:${c.id}`, title: 'Use k?', detail: [] };
    const res = await approvals.requestApproval(req);
    expect(res.status).toBe('pending');
    const id = (res as { id: string }).id;
    const card = (await fakeCalls()).filter((x) => x.method === 'chat.postEphemeral' && x.args.user === owner).at(-1);
    expect(JSON.stringify(card?.args.blocks)).toContain(approvals.APPROVE_WINDOW);

    await approvals.handleApprovalAction(click(uid(), approvals.APPROVE_ONCE, id) as any);
    expect((await approvals.loadApproval(id))!.status).toBe('pending');

    const waiting = approvals.waitForApproval(id);
    await approvals.handleApprovalAction(click(owner, approvals.APPROVE_WINDOW, id) as any);
    expect(await waiting).toBe('approved');
    expect((await approvals.requestApproval(req)).status).toBe('granted');
    expect((await approvals.requestApproval({ ...req, threadId: `${threadId}x` })).status).toBe('pending');
  });

  it('outcome mode: a denial starts an approval outcome turn exactly once', async () => {
    const owner = uid();
    const t = toolsFor('front', frontCtx(owner) as any);
    const out = await exec(t.request_credential, { name: 'jira', type: 'login', website: 'jira.example.com', why: 'to read your tickets' });
    expect(out).toContain('Asked');
    const [row] = await sql<{ id: string }[]>`select id from vault_approvals where owner_id = ${owner} and kind = 'credential_request'`;
    await approvals.handleApprovalAction(click(owner, approvals.DENY, row!.id) as any);
    await approvals.handleApprovalAction(click(owner, approvals.DENY, row!.id) as any);
    const turns = await sql<{ input: string }[]>`select input from scheduled_turn_inputs where source = 'approval' and source_ref = ${row!.id}`;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.input).toContain('declined');
  });

  it('child fetch_with_credential refuses other hosts and http before asking', async () => {
    const owner = uid();
    await store.saveCredential({ ownerId: owner, name: 'api', kind: 'token', meta: { domains: ['api.example.com'] }, secret: { value: 'tok_123456' } });
    const t = toolsFor('child', childCtx(owner) as any);
    expect(await exec(t.fetch_with_credential, { credential: 'api', url: 'https://evil.example.org/x', method: 'GET', purpose: 'p' })).toContain('may only be sent to api.example.com');
    expect(await exec(t.fetch_with_credential, { credential: 'api', url: 'http://api.example.com/x', method: 'GET', purpose: 'p' })).toContain('https');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from vault_approvals where owner_id = ${owner}`;
    expect(n!.n).toBe(0);
  });

  it('privacy wipe deletes everything', async () => {
    const owner = uid();
    await store.saveCredential({ ownerId: owner, name: 'a', kind: 'token', secret: { value: 'v' } });
    expect(await store.deleteAllVaultData(owner)).toBe(1);
    expect(await store.listCredentials(owner)).toHaveLength(0);
  });
});
