/**
 * Browser tools and the vault's sandbox side against the test Postgres/Redis, the fake Slack and the fake sandbox
 * provider, with agent-browser simulated from the composite command each tool sends (no Modal, no model calls):
 * snapshots and domain checks, the password-field rule, the kill switch, screenshots, credential fills (value over
 * stdin, never argv/env; scrubbed output; host pinning; approvals), vault files in /work/.vault (scrubbing, refusals,
 * cleanup at run end), saving a secret from a sandbox file, and saved browser sessions.
 *   INTEGRATION=1 pnpm vitest run src/sandbox/browser/browser.int.test.ts
 */
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
  process.env.MODAL_TOKEN_ID ||= 'fake-id';
  process.env.MODAL_TOKEN_SECRET ||= 'fake-secret';
  process.env.SANDBOX_MONTHLY_BUDGET_USD = '1000';
  process.env.SANDBOX_WORKSPACE_CREDIT_USD = '1000';
  process.env.VAULT_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.BROWSER_DENY_DOMAINS = 'evil.test';
});

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const PASSWORD = 'hunter2-Sup3rSecret!';
const TOKEN = 'sk-test-0123456789abcdef';

interface Call {
  cmd: string;
  stdin?: string;
  env?: Record<string, string>;
}

describe.skipIf(!INTEGRATION)('browser tools', () => {
  let sql: typeof import('../../db/index.js').sql;
  let redis: typeof import('../../core/redis.js').redis;
  let toolsFor: typeof import('../../core/tools.js').toolsFor;
  let fake: InstanceType<typeof import('../fake-provider.js').FakeProvider>;
  let store: typeof import('../../features/vault/store.js');
  let approvals: typeof import('../../features/vault/approvals.js');
  let settings: typeof import('../settings.js');
  let hooks: typeof import('../hooks.js');
  let png: Buffer;
  const CH = `CBRW${rand()}`;
  const threads: string[] = [];
  const users: string[] = [];
  let calls: Call[] = [];
  /** The simulated browser. */
  const page = { url: 'about:blank', title: '', fieldEcho: '' };
  let savedState = '';

  const newThread = async () => {
    const ts = `1791${Math.floor(Math.random() * 1e6)}.000100`;
    const id = `${CH}:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${id}, ${CH}, ${ts}) on conflict do nothing`;
    threads.push(id);
    return id;
  };
  const newUser = async () => {
    const u = `UBRW${rand()}`;
    users.push(u);
    await sql`insert into sandbox_allowlist (user_id, added_by) values (${u}, 'test')`;
    return u;
  };
  const newSubagent = async (threadId: string, owner: string) => {
    const id = `sa_${rand().toLowerCase()}`;
    await sql`insert into subagents (id, thread_id, owner_id, title, status, sandbox) values (${id}, ${threadId}, ${owner}, 'Test', 'running', true)`;
    const [r] = await sql<{ id: number }[]>`insert into runs (subagent_id, thread_id, instructions, status) values (${id}, ${threadId}, 'x', 'running') returning id`;
    return { subagentId: id, runId: Number(r!.id) };
  };
  const setup = async () => {
    const t = await newThread();
    const u = await newUser();
    const sa = await newSubagent(t, u);
    const [channelId, threadTs] = t.split(':') as [string, string];
    return { t, u, sa, ctx: { threadId: t, channelId, threadTs, speakerId: u, subagentId: sa.subagentId, runId: sa.runId, extras: {} } };
  };
  const call = (ctx: any, name: string, input: object) => (toolsFor('child', ctx)[name] as any).execute(input, { toolCallId: `tc${rand()}`, messages: [] });
  const grant = (owner: string, key: string, threadId: string) =>
    sql`insert into vault_grants (owner_id, grant_key, thread_id, expires_at) values (${owner}, ${key}, ${threadId}, now() + interval '10 minutes') on conflict do nothing`;
  /** The pending approval card for an owner, once it exists. */
  const pendingFor = async (owner: string) => {
    for (let i = 0; i < 100; i++) {
      const [row] = await sql<{ id: string }[]>`select id from vault_approvals where owner_id = ${owner} and status = 'pending' order by created_at desc limit 1`;
      if (row) return (await approvals.loadApproval(row.id))!;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no approval card');
  };
  const events = (threadId: string) => sql<{ payload: any }[]>`select payload from thread_events where thread_id = ${threadId} and type = 'browser_action' order by id`;
  /** The action log is written in the background: wait for an event matching `pred`. */
  const eventWhere = async (threadId: string, pred: (p: any) => boolean) => {
    for (let i = 0; i < 40; i++) {
      const hit = (await events(threadId)).find((e) => pred(e.payload));
      if (hit) return hit.payload;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no such browser_action event');
  };

  /** agent-browser, simulated from the composite command. */
  function simulate(cmd: string, box: { files: Map<string, Buffer> }, stdin?: Buffer, env?: Record<string, string>) {
    const has = (s: string) => cmd.includes(s);
    if (has('NOT_PASSWORD_FIELD') && !has(`get attr '@e4' type`)) return { stdout: 'NOT_PASSWORD_FIELD\n', exitCode: 3 };
    if (has('PASSWORD_FIELD') && !has('NOT_PASSWORD_FIELD') && has(`get attr '@e4' type`)) return { stdout: 'PASSWORD_FIELD\n', exitCode: 3 };
    if (has('ORIGIN_CHANGED') && !(page.url === env?.SBX_ORIGIN || page.url.startsWith(`${env?.SBX_ORIGIN}/`))) return { stdout: 'ORIGIN_CHANGED\n', exitCode: 3 };
    if (has(`'state' 'save'`)) return { stdout: savedState };
    if (has(`'state' 'load'`)) return { stdout: '✓ state loaded\n' };
    let out = '';
    const action = /\{ (.*); \} 2>&1/.exec(cmd)?.[1];
    if (action) {
      const open = /'open' '([^']+)'/.exec(action)?.[1];
      if (open) {
        page.url = open.includes('redirect-me') ? 'https://evil.test/landing?x=1' : open;
        page.title = open === 'about:blank' ? '' : 'Login – Example';
      }
      if (action.includes(`"$SBX_VALUE"`)) page.fieldEcho = (stdin?.toString('utf8') ?? '').replace(/\0$/, '');
      const shot = /'screenshot'.* '(\/tmp\/[^']+\.png)'/.exec(action)?.[1];
      if (shot) box.files.set(shot, png);
      out += `\n@@ab:action@@\n✓ done\n@@ab:rc=0@@\n`;
    }
    if (has(`'get' 'url'`)) out += `\n@@ab:url@@\n${page.url}\n`;
    if (has(`'get' 'title'`)) out += `\n@@ab:title@@\n${page.title}\n`;
    if (has(`'snapshot'`))
      out += `\n@@ab:snapshot@@\n- textbox "Email" [ref=e3]\n- textbox "Password" [ref=e4]${page.fieldEcho ? ` value="${page.fieldEcho}"` : ''}\n- button "Sign in" [ref=e5]\n`;
    if (has(`'read'`)) out += `\n@@ab:body@@\nWelcome to the example page.\n`;
    if (cmd.includes('@@ab:end@@')) out += '\n@@ab:end@@\n';
    return { stdout: out };
  }

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    ({ redis } = await import('../../core/redis.js'));
    const { migrate } = await import('../../db/migrate.js');
    await migrate();
    ({ toolsFor } = await import('../../core/tools.js'));
    const { FakeProvider } = await import('../fake-provider.js');
    const { setSandboxProvider } = await import('../providers.js');
    fake = new FakeProvider();
    setSandboxProvider(fake);
    await import('../../tools/index.js');
    store = await import('../../features/vault/store.js');
    approvals = await import('../../features/vault/approvals.js');
    settings = await import('../settings.js');
    hooks = await import('../hooks.js');
    const sharp = (await import('sharp')).default;
    png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#ffffff' } }).png().toBuffer();
  });

  beforeEach(() => {
    calls = [];
    page.url = 'about:blank';
    page.title = '';
    page.fieldEcho = '';
    fake.onExec = (cmd, box, stdin, env) => {
      calls.push({ cmd, ...(stdin ? { stdin: stdin.toString('utf8') } : {}), ...(env ? { env } : {}) });
      return simulate(cmd, box, stdin, env);
    };
  });

  afterAll(async () => {
    if (!INTEGRATION) return;
    await settings.setSandboxSetting('browserDisabled', false).catch(() => {});
    for (const t of threads) {
      await sql`delete from sandboxes where thread_id = ${t}`;
      await sql`delete from sandbox_usage where thread_id = ${t}`;
      await sql`delete from threads where id = ${t}`;
    }
    for (const u of users) {
      await store.deleteAllVaultData(u);
      await sql`delete from sandbox_allowlist where user_id = ${u}`;
      await sql`delete from sandbox_first_use where user_id = ${u}`;
    }
    const { closeQueues, queue, QUEUE } = await import('../../core/queues.js');
    await queue(QUEUE.sandbox).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await sql.end();
    redis.disconnect();
  });

  it('browser_open returns title, URL and refs as untrusted content, and logs the action without the query', async () => {
    const { t, ctx } = await setup();
    const out: string = await call(ctx, 'browser_open', { url: 'example.com/login?next=%2Fhome' });
    expect(out).toMatch(/^Opened\./);
    expect(out).toContain('<untrusted_content source="browser page">');
    expect(out).toContain('URL: https://example.com/login?next=%2Fhome');
    expect(out).toContain('[ref=e4]');
    expect(calls[0]!.cmd).toContain(`'open' 'https://example.com/login?next=%2Fhome'`);
    const ev = await eventWhere(t, (p) => p.action === 'open');
    expect(ev).toMatchObject({ action: 'open', host: 'example.com', path: '/login', runId: ctx.runId });
    expect(JSON.stringify(ev)).not.toContain('next=');
  });

  it('refuses private and denied URLs before opening, and leaves a page that navigated somewhere denied', async () => {
    const { t, ctx } = await setup();
    expect(await call(ctx, 'browser_open', { url: 'http://169.254.169.254/latest' })).toMatch(/^Not opened:/);
    expect(await call(ctx, 'browser_open', { url: 'https://sub.evil.test/' })).toMatch(/^Not opened: sub\.evil\.test is blocked/);
    expect(calls).toHaveLength(0);
    const out: string = await call(ctx, 'browser_open', { url: 'https://example.com/redirect-me' });
    expect(out).toMatch(/evil\.test.*refused.*about:blank/);
    expect(out).not.toContain('[ref=e4]');
    expect(calls.at(-1)!.cmd).toContain(`'open' 'about:blank'`);
    expect(await eventWhere(t, (p) => p.host === 'evil.test')).toMatchObject({ action: 'open', blocked: true, path: null });
    expect(await eventWhere(t, (p) => p.host === 'sub.evil.test')).toMatchObject({ blocked: true });
  });

  it('browser_fill types into text fields (only the length is logged) and refuses password fields', async () => {
    const { t, ctx } = await setup();
    await call(ctx, 'browser_open', { url: 'https://example.com/login' });
    const ok: string = await call(ctx, 'browser_fill', { ref: 'e3', text: 'me@example.com', submit: true });
    expect(ok).toMatch(/^Filled @e3 and pressed Enter\./);
    expect(calls.at(-1)!.cmd).toContain(`{ agent-browser 'fill' '@e3' '--' 'me@example.com' && agent-browser 'press' 'Enter'; }`);
    expect(await eventWhere(t, (p) => p.action === 'fill_submit')).toMatchObject({ ref: '@e3', textLength: 14 });
    expect(JSON.stringify((await events(t)).map((e) => e.payload))).not.toContain('me@example.com');
    expect(await call(ctx, 'browser_fill', { ref: '@e4', text: 'guess' })).toMatch(/password field: you never type passwords yourself/);
    expect(await call(ctx, 'browser_click', { ref: '#submit' })).toMatch(/isn't an element ref/);
  });

  it('the admin kill switch turns the browser tools off', async () => {
    const { ctx } = await setup();
    await settings.setSandboxSetting('browserDisabled', true);
    try {
      expect(await call(ctx, 'browser_open', { url: 'https://example.com/' })).toMatch(/turned off/);
      expect(calls).toHaveLength(0);
    } finally {
      await settings.setSandboxSetting('browserDisabled', false);
    }
  });

  it('browser_read pages text; browser_screenshot returns the image and deletes the file', async () => {
    const { ctx } = await setup();
    await call(ctx, 'browser_open', { url: 'https://example.com/' });
    const text: string = await call(ctx, 'browser_read', {});
    expect(text).toContain('Welcome to the example page.');
    expect(text).toMatch(/chars 0–\d+ of \d+/);
    const shot = await call(ctx, 'browser_screenshot', { annotate: true });
    expect(shot).toMatchObject({ mediaType: expect.stringMatching(/^image\//), width: 8, height: 6 });
    expect(shot.header).toContain('https://example.com/');
    expect(fake.scripts.at(-1)).toMatch(/^rm -f -- '\/tmp\/browser-shot-/);
  });

  it('browser_fill_credential types a stored password over stdin on its own site only, scrubbed, after approval', async () => {
    const { t, u, ctx } = await setup();
    const c = await store.saveCredential({ ownerId: u, name: 'example', kind: 'login', meta: { domains: ['example.com'] }, secret: { username: 'me@example.com', password: PASSWORD } });
    // Wrong site: refused, nothing asked or typed.
    await call(ctx, 'browser_open', { url: 'https://other.test/login' });
    expect(await call(ctx, 'browser_fill_credential', { ref: '@e4', credential: 'example', field: 'password' })).toMatch(/may only be typed into example\.com/);
    // Right site, approval denied on the card.
    await call(ctx, 'browser_open', { url: 'https://login.example.com/signin' });
    const pending = call(ctx, 'browser_fill_credential', { ref: '@e4', credential: 'example', field: 'password', purpose: 'Log in to check the invoice' });
    const card = await pendingFor(u);
    expect(card.title).toContain('password');
    expect(card.title).toContain('login.example.com');
    expect(card.detail.join('\n')).toContain('@e4');
    await approvals.decide(card, 'denied');
    expect(await pending).toMatch(/owner denied/);
    expect(calls.some((x) => x.cmd.includes('SBX_VALUE') && x.cmd.includes(`'fill'`) && x.stdin)).toBe(false);
    // Allowed for 10 minutes in this thread: typed.
    await grant(u, `cred:${c.id}`, t);
    const out: string = await call(ctx, 'browser_fill_credential', { ref: '@e4', credential: 'example', field: 'password' });
    expect(out).toMatch(/^Typed the password of "example" into @e4/);
    const fill = calls.at(-1)!;
    expect(fill.stdin).toBe(`${PASSWORD}\0`);
    expect(fill.cmd).not.toContain(PASSWORD);
    expect(JSON.stringify(fill.env)).not.toContain(PASSWORD);
    expect(fill.env!.SBX_ORIGIN).toBe('https://login.example.com');
    // The simulated page echoes the value in the snapshot: the model sees it redacted.
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain('[redacted:example:password]');
    // A password into a non-password field is refused in the sandbox.
    expect(await call(ctx, 'browser_fill_credential', { ref: '@e3', credential: 'example', field: 'password' })).toMatch(/isn't a password field/);
    const [a] = await sql<{ outcome: string; detail: any }[]>`select outcome, detail from vault_audit where owner_id = ${u} and action = 'browser_fill' and outcome = 'ok'`;
    expect(a!.detail).toMatchObject({ host: 'login.example.com', field: 'password' });
  });

  it('sandbox_use_credential writes /work/.vault files, scrubs them from output, refuses reading them, and removes them at run end', async () => {
    const { t, u, sa, ctx } = await setup();
    const c = await store.saveCredential({ ownerId: u, name: 'api', kind: 'token', meta: {}, secret: { value: TOKEN } });
    await grant(u, `cred:${c.id}:sandbox`, t);
    expect(await call(ctx, 'sandbox_use_credential', { credential: 'api', purpose: 'call the API' })).toMatch(/^Ready: \/work\/\.vault\/api/);
    const box = fake.live().find((b) => b.files.has('/work/.vault/api'))!;
    expect(box.files.get('/work/.vault/api')!.toString()).toBe(TOKEN);
    expect(fake.scripts.find((s) => s.endsWith(`cat > '/work/.vault/api'`))).toMatch(/^umask 077 && mkdir -p '\/work\/\.vault' && chmod 700/);
    fake.onExec = () => ({ stdout: `token is ${TOKEN}\n` });
    const out: string = await call(ctx, 'sandbox_exec', { command: 'cat /work/.vault/api' });
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('[redacted:api]');
    expect(await call(ctx, 'sandbox_read_file', { path: '/work/.vault/api' })).toMatch(/never read, print or export/);
    expect(await call(ctx, 'sandbox_export', { path: '.vault/api', description: 'x' })).toMatch(/never read, print or export/);
    await sql`update runs set status = 'complete', finished_at = now() where id = ${sa.runId}`;
    await hooks.onSandboxRunFinished(sa.runId);
    expect(box.files.has('/work/.vault/api')).toBe(false);
  });

  it('sandbox_save_credential stores a secret from a file without showing it, deletes the file and never overwrites', async () => {
    const { u, ctx } = await setup();
    await call(ctx, 'sandbox_exec', { command: 'true' });
    const box = fake.live().at(-1)!;
    box.files.set('/work/out/key.txt', Buffer.from(`${TOKEN}\n`));
    const out: string = await call(ctx, 'sandbox_save_credential', { name: 'new-key', type: 'api_key', website: 'api.example.com', file: 'out/key.txt' });
    expect(out).toMatch(/^Saved "new-key"/);
    expect(out).not.toContain(TOKEN);
    const c = (await store.getCredential(u, 'new-key'))!;
    expect(c.meta.domains).toEqual(['api.example.com']);
    expect((await store.revealSecret({ ...c, kind: 'token' })).value).toBe(TOKEN);
    expect(fake.scripts.at(-1)).toBe(`rm -f -- '/work/out/key.txt'`);
    expect(await call(ctx, 'sandbox_save_credential', { name: 'new-key', type: 'api_key', file: 'out/key.txt' })).toMatch(/already exists/);
    expect(await call(ctx, 'sandbox_save_credential', { name: 'copy', type: 'api_key', file: '/work/.vault/x' })).toMatch(/already in the vault/);
  });

  it('browser_save_session keeps one site after approval; browser_load_session loads it into another subagent over stdin', async () => {
    const { t, u, ctx } = await setup();
    savedState = JSON.stringify({
      cookies: [
        { name: 'sid', value: 'abc', domain: '.example.com', path: '/' },
        { name: 'other', value: 'zzz', domain: 'tracker.test', path: '/' },
      ],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'k', value: 'v' }] }],
    });
    await call(ctx, 'browser_open', { url: 'https://app.example.com/' });
    const pending = call(ctx, 'browser_save_session', { name: 'example-session', website: 'example.com', purpose: 'stay logged in for next week' });
    const card = await pendingFor(u);
    expect(card.title).toContain('example.com');
    expect(card.detail.join('\n')).toContain('1 cookie');
    await approvals.decide(card, 'approved', 'once');
    expect(await pending).toMatch(/^Saved the browser login for example\.com as "example-session"/);
    const c = (await store.getCredential(u, 'example-session'))!;
    expect(c.kind).toBe('browser_session');
    const kept = JSON.parse((await store.revealSecret({ ...c, kind: 'browser_session' })).state);
    expect(kept.cookies.map((x: any) => x.name)).toEqual(['sid']);

    // A later subagent of the same owner, in the same thread, with the 10-minute grant.
    const sa2 = await newSubagent(t, u);
    const ctx2 = { ...ctx, subagentId: sa2.subagentId, runId: sa2.runId };
    await grant(u, `cred:${c.id}`, t);
    expect(await call(ctx2, 'browser_load_session', { name: 'example-session', purpose: 'check the dashboard' })).toMatch(/^Loaded the saved login "example-session"/);
    const load = calls.at(-1)!;
    expect(load.cmd).toContain(`'state' 'load'`);
    expect(load.cmd).not.toContain('abc');
    expect(JSON.parse(load.stdin!).cookies[0].value).toBe('abc');
    // The hint after open names it.
    expect(await call(ctx2, 'browser_open', { url: 'https://app.example.com/' })).toContain('Saved browser login for this site: `example-session`');
    // Someone else's subagent can't use it.
    const other = await setup();
    expect(await call(other.ctx, 'browser_load_session', { name: 'example-session', purpose: 'x' })).toMatch(/No saved browser login/);
  });
});
