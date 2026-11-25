/**
 * Connector integration: a tiny in-process MCP server (Streamable HTTP, JSON responses) on 127.0.0.1, the real vault,
 * Postgres and Redis (test infra), fake Slack. Catalog and verifier are mocked.
 * Run: INTEGRATION=1 pnpm vitest run src/features/connectors/connectors.int.test.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectorDef } from './logic.js';

const INTEGRATION = process.env.INTEGRATION === '1';
const h = vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.env.VAULT_SECRET_KEY ||= Buffer.alloc(32, 7).toString('base64');
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
  return { def: null as ConnectorDef | null, verifierApproves: false };
});

vi.mock('./catalog.js', async (orig) => ({
  ...(await orig<typeof import('./catalog.js')>()),
  enabledConnectors: async () => (h.def ? [h.def] : []),
  enabledConnector: async (slug: string | undefined) => (h.def && slug === h.def.slug ? h.def : null),
}));
vi.mock('./verifier.js', () => ({
  verifyConnectorCall: vi.fn(async () => ({ approved: h.verifierApproves, reason: 'test', model: 'test' })),
}));

const KEY = 'sk-test-0123456789abcdef';

/** Minimal MCP server: initialize, tools/list, tools/call (needs Bearer KEY). */
function startServer(): Promise<{ server: http.Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') return void res.writeHead(405).end();
    if (req.method === 'DELETE') return void res.writeHead(200).end();
    if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) return void res.writeHead(202).end();
      const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'initialize') return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } });
      if (msg.method === 'tools/list')
        return reply({
          tools: [
            { name: 'get_note', description: 'Read a note', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
            { name: 'add.note', description: 'Add a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
            { name: 'wipe', description: 'Delete everything', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
            { name: 'slow', description: 'Takes a while', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          ],
        });
      if (msg.method === 'tools/call') {
        calls.push(msg.params.name);
        if (msg.params.name === 'slow') await new Promise((r) => setTimeout(r, 8000));
        return reply({ content: [{ type: 'text', text: `called ${msg.params.name} ${JSON.stringify(msg.params.arguments)} with key ${KEY}` }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] });
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls })));
}

describe.skipIf(!INTEGRATION)('connectors integration', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let sql: typeof import('../../db/index.js').sql;
  let redis: typeof import('../../core/redis.js').redis;
  let tools: typeof import('./tools.js');
  let conn: typeof import('./connection.js');
  let settings: typeof import('./settings.js');
  const owner = `UC${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const threadId = `C123:${Date.now()}.000100`;
  const turn = { kind: 'user' as const, authorId: owner, ephemeral: false, threadId };
  const exec = (t: any, input: unknown) => t.execute(input, { toolCallId: 'x', messages: [] });

  beforeAll(async () => {
    srv = await startServer();
    h.def = { slug: 'notes', name: 'Notes', description: 'test', url: srv.url, auth: { type: 'api_key' } };
    ({ sql } = await import('../../db/index.js'));
    ({ redis } = await import('../../core/redis.js'));
    (await import('./egress.js')).__setConnectorTestAllowIps(['127.0.0.1']);
    tools = await import('./tools.js');
    conn = await import('./connection.js');
    settings = await import('./settings.js');
    tools.registerConnectorExecutor();
    await conn.saveApiKeyConnection(owner, h.def, KEY);
  });

  afterAll(async () => {
    await sql`delete from vault_credentials where owner_id = ${owner}`;
    await sql`delete from vault_approvals where owner_id = ${owner}`;
    await sql`delete from vault_audit where owner_id = ${owner}`;
    await sql`delete from connector_settings where owner_id = ${owner}`;
    srv.server.close();
    await sql.end();
    redis.disconnect();
  });

  it('builds only the owner’s allowed tools, on their user turns', async () => {
    const t = await tools.loadConnectorTools({ turn, speakerId: owner, taken: ['reply'] });
    expect(Object.keys(t).sort()).toEqual(['notes__add_note', 'notes__get_note', 'notes__slow']);
    expect(await tools.loadConnectorTools({ turn: { ...turn, kind: 'scheduled' }, speakerId: owner, taken: [] })).toEqual({});
    expect(await tools.loadConnectorTools({ turn: { ...turn, authorId: 'UOTHER' }, speakerId: 'UOTHER', taken: [] })).toEqual({});
    expect(await tools.loadConnectorTools({ turn, speakerId: 'UOTHER', taken: [] })).toEqual({});
    // !p: prompt-mode tools are left out.
    expect(Object.keys(await tools.loadConnectorTools({ turn: { ...turn, ephemeral: true }, speakerId: owner, taken: [] })).sort()).toEqual(['notes__get_note', 'notes__slow']);
  });

  it('always_allow calls; the result is scrubbed, text-only and untrusted', async () => {
    await settings.setKnob(owner, 'notes', 'read', 'always_allow');
    const t = await tools.loadConnectorTools({ turn, speakerId: owner, taken: [] });
    const out = String(await exec(t.notes__get_note, { id: 'n1' }));
    expect(out).toContain('<untrusted_content');
    expect(out).toContain('called get_note {"id":"n1"}');
    expect(out).toContain('[redacted:mcp.notes]');
    expect(out).not.toContain(KEY);
    expect(out).toContain('[1 non-text item(s) omitted]');
    const [a] = await sql`select outcome, detail from vault_audit where owner_id = ${owner} and action = 'connector_call' order by id desc limit 1`;
    expect(a!.outcome).toBe('ok');
    expect(JSON.stringify(a!.detail)).not.toContain('n1');
  });

  it('auto mode refuses when the verifier says no (fail closed)', async () => {
    await settings.setKnob(owner, 'notes', 'read', 'auto');
    h.verifierApproves = false;
    const before = srv.calls.length;
    const t = await tools.loadConnectorTools({ turn, speakerId: owner, taken: [] });
    expect(String(await exec(t.notes__get_note, {}))).toMatch(/^Not done: the safety check/);
    expect(srv.calls.length).toBe(before);
    h.verifierApproves = true;
    expect(String(await exec(t.notes__get_note, {}))).toContain('called get_note');
  });

  it('prompt mode posts a card and does not call', async () => {
    const before = srv.calls.length;
    const t = await tools.loadConnectorTools({ turn, speakerId: owner, taken: [] });
    expect(String(await exec(t.notes__add_note, { text: 'hi' }))).toMatch(/^Awaiting approval/);
    expect(srv.calls.length).toBe(before);
    const [row] = await sql`select kind, grant_key, status from vault_approvals where owner_id = ${owner} order by created_at desc limit 1`;
    expect(row).toMatchObject({ kind: 'connector_call', grantKey: 'conn:notes:add.note', status: 'pending' });
  });

  it('a setting changed to Never after the build refuses at call time', async () => {
    const t = await tools.loadConnectorTools({ turn, speakerId: owner, taken: [] });
    await settings.setOverrides(owner, 'notes', { get_note: 'always_block' });
    expect(String(await exec(t.notes__get_note, {}))).toMatch(/blocked/);
    await settings.setOverrides(owner, 'notes', {});
  });

  it('disconnecting aborts an in-flight call', async () => {
    await settings.setKnob(owner, 'notes', 'read', 'always_allow');
    const t = await tools.loadConnectorTools({ turn, speakerId: owner, taken: [] });
    const started = Date.now();
    const p = exec(t.notes__slow, {});
    await new Promise((r) => setTimeout(r, 700));
    await settings.revokeConnection(owner, 'notes');
    const out = String(await p);
    expect(out).toMatch(/disconnected/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('egress is pinned to the server origin', async () => {
    const { pinnedFetch } = await import('./egress.js');
    const f = pinnedFetch({ mcpOrigin: new URL(srv.url).origin, authOrigins: new Set() }, { timeoutMs: 2000 });
    await expect(f('https://example.com/')).rejects.toThrow(/blocked/);
    expect((await f(srv.url, { method: 'GET', headers: { accept: 'text/event-stream' } })).status).toBe(405);
  });
});
