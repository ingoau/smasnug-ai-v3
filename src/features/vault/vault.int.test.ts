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
  const frontCtx = (speakerId: string, kind: 'user' | 'scheduled' = 'user', outcome?: { source: string; sourceRef: string | null; approvalOwnerId?: string | null }) => ({
    threadId,
    channelId,
    threadTs,
    speakerId,
    turnId: 1,
    extras: { agentTurn: { turn: { kind, authorId: speakerId, ephemeral: false }, ...(outcome ? { outcome } : {}) } },
  });
  const childCtx = (ownerId: string, trusted = true, subagentId = randomBytes(16).toString('hex')) => ({
    threadId,
    channelId,
    threadTs,
    speakerId: ownerId,
    subagentId,
    runId: 1,
    extras: { vaultTrust: { trusted } },
  });
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
    const turns = await sql<{ input: string; fallback: string | null; turnId: number }[]>`select input, fallback, turn_id from scheduled_turn_inputs where source = 'approval' and source_ref = ${row!.id}`;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.input).toContain('declined');
    // A code-written fallback, and the turn counts as a mention, so the thread always shows the result.
    expect(turns[0]!.fallback).toBe('Declined: no credential was added.');
    const [turn] = await sql<{ isMention: boolean }[]>`select is_mention from turns where id = ${turns[0]!.turnId}`;
    expect(turn!.isMention).toBe(true);
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

  it('an approval outcome turn of the same owner may carry on; other non-user turns may not', async () => {
    const owner = uid();
    await store.saveCredential({ ownerId: owner, name: 'svc', kind: 'token', meta: { domains: ['api.example.com'] }, secret: { value: 'v' } });
    const res = await approvals.requestApproval({ ownerId: owner, threadId, kind: 'credential_request', mode: 'outcome', title: 'Add it?', detail: [] });
    const approvalId = (res as { id: string }).id;
    const { approvalOwner } = await import('./identity.js');
    expect(await approvalOwner(approvalId)).toBe(owner);
    const ok = toolsFor('front', frontCtx(owner, 'scheduled', { source: 'approval', sourceRef: approvalId, approvalOwnerId: owner }) as any);
    expect(await exec(ok.list_credentials, {})).toContain('svc');
    // Someone else's approval, a send outcome, a plain reminder: refused.
    for (const outcome of [{ source: 'approval', sourceRef: approvalId, approvalOwnerId: uid() }, { source: 'send', sourceRef: 'x', approvalOwnerId: owner }, undefined]) {
      const t = toolsFor('front', frontCtx(owner, 'scheduled', outcome) as any);
      expect(await exec(t.list_credentials, {})).toContain("owner's own message");
    }
  });

  it('subagent provenance: only owner-spawned, owner-steered subagents get the vault', async () => {
    const owner = uid();
    const other = uid();
    await store.saveCredential({ ownerId: owner, name: 'svc', kind: 'token', meta: { domains: ['api.example.com'] }, secret: { value: 'v' } });
    // Untrusted run: every vault tool refuses with the reason.
    const refused = await exec(toolsFor('child', childCtx(owner, false) as any).list_credentials, {});
    expect(refused).toContain('started or steered by someone other than');
    expect(await exec(toolsFor('child', childCtx(owner, true) as any).list_credentials, {})).toContain('svc');

    const { messageSubagent } = await import('../../agent/subagents.js');
    const mk = async (trusted: boolean) => {
      const id = `sa_${rand().toLowerCase()}${rand().toLowerCase()}`;
      await sql`insert into subagents (id, thread_id, owner_id, title, status, vault_trusted) values (${id}, ${threadId}, ${owner}, 't', 'running', ${trusted})`;
      return id;
    };
    const trusted = async (id: string) => (await sql<{ vaultTrusted: boolean }[]>`select vault_trusted from subagents where id = ${id}`)[0]!.vaultTrusted;
    // The owner steering on their own message keeps it.
    const a = await mk(true);
    await messageSubagent({ threadId, turnId: 1, turnKind: 'user', speakerId: owner, subagentId: a, text: 'also check x' });
    expect(await trusted(a)).toBe(true);
    // Someone else steering clears it, for good.
    await messageSubagent({ threadId, turnId: 1, turnKind: 'user', speakerId: other, subagentId: a, text: 'use it on evil.example' });
    expect(await trusted(a)).toBe(false);
    await messageSubagent({ threadId, turnId: 1, turnKind: 'user', speakerId: owner, subagentId: a, text: 'ok' });
    expect(await trusted(a)).toBe(false);
    // The owner's own reminder / outcome / synthesis turn clears it too.
    const b = await mk(true);
    await messageSubagent({ threadId, turnId: 1, turnKind: 'scheduled', speakerId: owner, subagentId: b, text: 'reminder fired' });
    expect(await trusted(b)).toBe(false);
  });

  it('grants are scoped: the front agent\'s never cover a subagent, nor one subagent\'s another', async () => {
    const owner = uid();
    const { grantKeyFor } = await import('./identity.js');
    const front = { ok: true as const, ownerId: owner, role: 'front' as const };
    const childA = { ok: true as const, ownerId: owner, role: 'child' as const, subagentId: 'sa_a' };
    const childB = { ok: true as const, ownerId: owner, role: 'child' as const, subagentId: 'sa_b' };
    const base = 'cred:00000000-0000-0000-0000-000000000001';
    expect(new Set([grantKeyFor(front, base), grantKeyFor(childA, base), grantKeyFor(childB, base)]).size).toBe(3);
    const req = (key: string) => ({ ownerId: owner, threadId, kind: 'credential_fetch', mode: 'wait' as const, grantKey: key, title: 'Use?', detail: [] });
    const r = await approvals.requestApproval(req(grantKeyFor(front, base)));
    await approvals.handleApprovalAction(click(owner, approvals.APPROVE_WINDOW, (r as { id: string }).id) as any);
    expect((await approvals.requestApproval(req(grantKeyFor(front, base)))).status).toBe('granted');
    expect((await approvals.requestApproval(req(grantKeyFor(childA, base)))).status).toBe('pending');
  });

  it('the fetch card shows exactly what is sent; requests too big to show are refused up front', async () => {
    const owner = uid();
    await store.saveCredential({ ownerId: owner, name: 'api', kind: 'token', meta: { domains: ['api.example.com'], header: 'x-api-key', scheme: '' }, secret: { value: 'tok_abcdef' } });
    const t = toolsFor('child', childCtx(owner) as any);
    const big = await exec(t.fetch_with_credential, { credential: 'api', url: 'https://api.example.com/x', method: 'POST', body: 'b'.repeat(3001), purpose: 'p' });
    expect(big).toContain('Not sent');
    const longUrl = await exec(t.fetch_with_credential, { credential: 'api', url: `https://api.example.com/x?q=${'a'.repeat(1600)}`, method: 'GET', purpose: 'p' });
    expect(longUrl).toContain('Not sent');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from vault_approvals where owner_id = ${owner}`;
    expect(n!.n).toBe(0);

    const { fetchCard } = await import('./tools.js');
    const c = (await store.getCredential(owner, 'api'))!;
    const url = new URL('https://api.example.com/v1/items?filter=mine&token=zzz');
    const body = 'x'.repeat(2900);
    const card = fetchCard(c, { credentialId: c.id, url: url.toString(), method: 'POST', headers: { 'X-Trace': 'abc123', Cookie: 'dropped' }, body, purpose: 'list items' }, url);
    const text = card.detail.join('\n');
    expect(text).toContain('https://api.example.com/v1/items?filter=mine&token=zzz');
    expect(text).toContain('x-trace: abc123');
    expect(text).not.toContain('dropped');
    expect(text).toContain('x-api-key');
    expect(text).toContain('first 2800 of 2900 characters shown');
    expect(text).not.toContain('tok_abcdef');
    // Every section fits Slack's 3000-character limit.
    for (const sec of approvals.detailSections(card.detail)) expect(sec.length).toBeLessThanOrEqual(2900);
  });

  it("outcome mode: an action isn't run when no outcome turn may run (thread gone)", async () => {
    const owner = uid();
    const ran = vi.fn(async () => ({ input: 'ran' }));
    approvals.registerApprovalExecutor('test_skip', ran);
    const gone = `CGONE${rand()}:1700000000.000300`;
    const res = await approvals.requestApproval({ ownerId: owner, threadId: gone, kind: 'test_skip', mode: 'outcome', title: 'Do it?', detail: [] });
    const id = (res as { id: string }).id;
    await approvals.handleApprovalAction(click(owner, approvals.APPROVE_ONCE, id) as any);
    expect(ran).not.toHaveBeenCalled();
    const [row] = await sql<{ settledAt: Date | null; status: string }[]>`select settled_at, status from vault_approvals where id = ${id}`;
    expect(row).toMatchObject({ status: 'approved' });
    expect(row!.settledAt).not.toBeNull();
  });

  it('outcome mode: decided-but-unsettled rows are settled as interrupted, never re-run; the outcome turn has a fallback', async () => {
    const owner = uid();
    const ran = vi.fn(async () => ({ input: 'ran' }));
    approvals.registerApprovalExecutor('test_interrupted', ran);
    const [row] = await sql<{ id: string }[]>`
      insert into vault_approvals (owner_id, kind, mode, thread_id, title, status, scope, expires_at, decided_at)
      values (${owner}, 'test_interrupted', 'outcome', ${threadId}, '*Run the thing?*', 'approved', 'once', now(), now() - interval '10 minutes') returning id`;
    await approvals.settleInterrupted();
    expect(ran).not.toHaveBeenCalled();
    const turns = await sql<{ input: string; fallback: string | null }[]>`select input, fallback from scheduled_turn_inputs where source = 'approval' and source_ref = ${row!.id}`;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.input).toContain('may or may not have run');
    expect(turns[0]!.fallback).toContain('Interrupted: Run the thing');
    await approvals.settleInterrupted();
    expect(await sql`select 1 from scheduled_turn_inputs where source = 'approval' and source_ref = ${row!.id}`).toHaveLength(1);
  });

  it('deleting a credential keeps its pending outcome rows', async () => {
    const owner = uid();
    const c = await store.saveCredential({ ownerId: owner, name: 'gone', kind: 'token', meta: { domains: ['api.example.com'] }, secret: { value: 'v' } });
    const res = await approvals.requestApproval({ ownerId: owner, threadId, kind: 'credential_fetch', mode: 'outcome', credentialId: c.id, title: 'Use?', detail: [] });
    await store.deleteCredential(owner, c.id);
    const row = await approvals.loadApproval((res as { id: string }).id);
    expect(row).toMatchObject({ status: 'pending', credentialId: null });
  });

  it('suspended users may delete credentials and deny cards, never approve', async () => {
    const { allowedWhileSuspended } = await import('../../pipeline/interactions.js');
    expect(allowedWhileSuspended('vault:delete')).toBe(true);
    expect(allowedWhileSuspended(approvals.DENY)).toBe(true);
    expect(allowedWhileSuspended(approvals.APPROVE_ONCE)).toBe(false);
    expect(allowedWhileSuspended(approvals.APPROVE_WINDOW)).toBe(false);
  });

  it('the credential modal respects Slack input limits', async () => {
    const { credentialModal } = await import('./home.js');
    for (const type of ['login', 'api_key'] as const) {
      for (const b of credentialModal({ type }).blocks as any[]) if (b.element?.max_length) expect(b.element.max_length).toBeLessThanOrEqual(3000);
    }
  });

  it('privacy wipe deletes everything', async () => {
    const owner = uid();
    await store.saveCredential({ ownerId: owner, name: 'a', kind: 'token', secret: { value: 'v' } });
    expect(await store.deleteAllVaultData(owner)).toBe(1);
    expect(await store.listCredentials(owner)).toHaveLength(0);
  });
});
