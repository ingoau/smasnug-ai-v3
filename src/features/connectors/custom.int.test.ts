/**
 * Custom connectors ("Add connector"): validation, per-owner visibility, the admin switch, the reserved `u-` slug in the
 * catalog file, App Home, Remove and the privacy wipe. Real Postgres / Redis (test infra), fake Slack.
 * Run: INTEGRATION=1 pnpm vitest run src/features/connectors/custom.int.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
vi.hoisted(() => {
  if (process.env.INTEGRATION === '1') {
    process.env.VAULT_SECRET_KEY ||= Buffer.alloc(32, 7).toString('base64');
    process.loadEnvFile('.env');
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});

describe.skipIf(!INTEGRATION)('custom connectors', () => {
  let sql: typeof import('../../db/index.js').sql;
  let custom: typeof import('./custom.js');
  let catalog: typeof import('./catalog.js');
  let home: typeof import('./home.js');
  let env: typeof import('../../config.js').env;
  const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
  const owner = `UCU${rnd()}`;
  const other = `UCV${rnd()}`;
  const dir = mkdtempSync(join(tmpdir(), 'conn-cat-'));
  let savedFile = '';
  let acme = '';

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    ({ env } = await import('../../config.js'));
    custom = await import('./custom.js');
    catalog = await import('./catalog.js');
    home = await import('./home.js');
    savedFile = env.CONNECTORS_FILE;
    (env as any).CONNECTORS_FILE = join(dir, 'missing.json');
    catalog.resetCatalogCache();
  });

  afterAll(async () => {
    (env as any).CONNECTORS_FILE = savedFile;
    catalog.resetCatalogCache();
    await sql`delete from custom_connectors where owner_id in (${owner}, ${other})`;
    await sql`delete from settings where key = 'connectors_custom_off'`;
    rmSync(dir, { recursive: true, force: true });
  });

  it('validates, slugs and keeps each one to its owner', async () => {
    expect(await custom.addCustomConnector(owner, { name: 'Local', url: 'http://localhost:3000/mcp', auth: 'oauth' })).toMatchObject({ error: expect.stringMatching(/public https/) });
    // A name with "url" in it still gets the header error (the error's slug label isn't matched).
    expect(await custom.addCustomConnector(owner, { name: 'Curl API', url: 'https://mcp.example.com/mcp', auth: 'api_key', header: 'X Key' })).toMatchObject({ error: expect.stringMatching(/header/) });
    const a = await custom.addCustomConnector(owner, { name: 'Acme CRM', url: 'https://mcp.example.com/mcp', description: 'Our CRM', auth: 'oauth' });
    expect('def' in a && a.def).toMatchObject({ slug: expect.stringMatching(/^u-acme-crm-[0-9a-f]{4}$/), name: 'Acme CRM', description: 'Our CRM', auth: { type: 'oauth' } });
    acme = 'def' in a ? a.def.slug : '';
    expect(await custom.addCustomConnector(owner, { name: 'acme crm', url: 'https://mcp.example.com/other', auth: 'oauth' })).toMatchObject({ error: expect.stringMatching(/already have/) });
    const k = await custom.addCustomConnector(owner, { name: 'Keyed', url: 'https://keys.example.com/mcp', auth: 'api_key', header: 'X-Api-Key' });
    expect('def' in k && k.def.auth).toEqual({ type: 'api_key', header: 'x-api-key', scheme: '' });
    const b = await custom.addCustomConnector(owner, { name: 'Bearer', url: 'https://bearer.example.com/mcp', auth: 'api_key' });
    expect('def' in b && b.def.auth).toEqual({ type: 'api_key', header: 'authorization', scheme: 'Bearer' });

    const mine = (await catalog.enabledConnectors(owner)).map((d) => d.slug);
    expect(mine.map((x) => x.replace(/-[0-9a-f]{4}$/, ''))).toEqual(['u-acme-crm', 'u-keyed', 'u-bearer']);
    expect(await catalog.enabledConnectors(other)).toEqual([]);
    expect(await catalog.enabledConnector(acme, owner)).toMatchObject({ name: 'Acme CRM' });
    expect(await catalog.enabledConnector(acme, other)).toBeNull();
  });

  it('slugs are short, valid and never reused', () => {
    expect(custom.customSlug('Acme CRM', 'ab12')).toBe('u-acme-crm-ab12');
    expect(custom.customSlug('!!!', 'ab12')).toBe('u-connector-ab12');
    expect(custom.customSlug('a very long connector name indeed').length).toBeLessThanOrEqual(24);
    expect(custom.customSlug('Acme CRM')).not.toBe(custom.customSlug('Acme CRM'));
  });

  it('two submits at once cannot pass the cap together', async () => {
    const who = `UCW${rnd()}`;
    for (let i = 0; i < custom.MAX_CUSTOM_CONNECTORS - 1; i++) await custom.addCustomConnector(who, { name: `C${i}`, url: `https://c${i}.example.com/mcp`, auth: 'oauth' });
    const r = await Promise.all([1, 2, 3].map((i) => custom.addCustomConnector(who, { name: `Race ${i}`, url: `https://r${i}.example.com/mcp`, auth: 'oauth' })));
    expect(r.filter((x) => 'def' in x).length).toBe(1);
    expect((await sql`select 1 from custom_connectors where owner_id = ${who}`).length).toBe(custom.MAX_CUSTOM_CONNECTORS);
    await sql`delete from custom_connectors where owner_id = ${who}`;
  });

  it('caps how many one person can add', async () => {
    const n = (await catalog.enabledConnectors(owner)).length;
    for (let i = n; i < custom.MAX_CUSTOM_CONNECTORS; i++) expect('def' in (await custom.addCustomConnector(owner, { name: `Extra ${i}`, url: `https://x${i}.example.com/mcp`, auth: 'oauth' }))).toBe(true);
    expect(await custom.addCustomConnector(owner, { name: 'One too many', url: 'https://y.example.com/mcp', auth: 'oauth' })).toMatchObject({ error: expect.stringMatching(/up to/) });
    await sql`delete from custom_connectors where owner_id = ${owner} and name like 'Extra %'`;
  });

  it('the admin switch hides them (kept), and turning it on brings them back', async () => {
    await custom.setCustomConnectorsAllowed(false);
    expect(await catalog.enabledConnectors(owner)).toEqual([]);
    expect(await catalog.enabledConnector(acme, owner)).toBeNull();
    expect(JSON.stringify(await home.connectorsHomeBlocks(owner))).not.toContain('conn:add');
    await custom.setCustomConnectorsAllowed(true);
    expect((await catalog.enabledConnectors(owner)).length).toBe(3);
  });

  it('a catalog file entry may not use a u- slug', async () => {
    const file = join(dir, 'connectors.json');
    writeFileSync(
      file,
      JSON.stringify([
        { slug: 'u-sneaky', name: 'Sneaky', url: 'https://s.example.com/mcp', auth: { type: 'oauth' } },
        { slug: 'fine', name: 'Fine', url: 'https://f.example.com/mcp', auth: { type: 'oauth' } },
      ]),
    );
    (env as any).CONNECTORS_FILE = file;
    catalog.resetCatalogCache();
    const status = await catalog.loadCatalog();
    expect(status.defs.map((d) => d.slug)).toEqual(['fine']);
    expect(status.errors.join(' ')).toMatch(/u-sneaky.*reserved/);
    (env as any).CONNECTORS_FILE = join(dir, 'missing.json');
    catalog.resetCatalogCache();
  });

  it('App Home lists them with Remove and an Add button; Remove deletes it', async () => {
    const blocks = JSON.stringify(await home.connectorsHomeBlocks(owner));
    expect(blocks).toContain('Acme CRM');
    expect(blocks).toContain('added by you');
    expect(blocks).toContain('"action_id":"conn:remove"');
    expect(blocks).toContain('"action_id":"conn:add"');
    // Someone else's Home has the Add button but not this connector.
    const theirs = JSON.stringify(await home.connectorsHomeBlocks(other));
    expect(theirs).toContain('conn:add');
    expect(theirs).not.toContain('Acme CRM');
    // Another user can't remove it (only the clicker's own rows are touched).
    await home.handleConnectorAction({ userId: other, actionId: 'conn:remove', value: acme, body: {} } as any, async () => {});
    expect(await catalog.enabledConnector(acme, owner)).not.toBeNull();
    await home.handleConnectorAction({ userId: owner, actionId: 'conn:remove', value: acme, body: {} } as any, async () => {});
    expect(await catalog.enabledConnector(acme, owner)).toBeNull();
    // Added again under the same name: a new slug, so nothing of the removed one can attach to it.
    const again = await custom.addCustomConnector(owner, { name: 'Acme CRM', url: 'https://other.example.com/mcp', auth: 'oauth' });
    expect('def' in again && again.def.slug).not.toBe(acme);
  });

  it('withdrawing privacy consent deletes them', async () => {
    expect((await catalog.enabledConnectors(owner)).length).toBeGreaterThan(0);
    await (await import('./settings.js')).deleteConnectorData(owner);
    expect(await catalog.enabledConnectors(owner)).toEqual([]);
  });
});
