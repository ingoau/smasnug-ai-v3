import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { bannerHtml, checkLimits, HEADERS_FILE, injectBanner, normalizeEntries, prepareBundle, scanForms, wranglerConfig } from './bundle.js';
import { decryptSecret, encryptSecret, previewKey } from './crypto.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeployRecord, parseDeployUrl, parseSimpleToml, pickTemporaryAccount, readDeployOutputScript, redact, TEMP_ACCOUNT_FILE } from './deploy.js';
import { readTar, writeTar } from './tar.js';
import { previewMessage, termsBlocks } from './flow.js';

const f = (path: string, text: string) => ({ path, data: Buffer.from(text) });
const opts = { requester: '@Ingo', expiresAt: new Date('2026-10-07T12:34:00Z'), botName: 'smasnug ai' };

describe('tar', () => {
  it('round-trips files, including long paths', () => {
    const long = `${'d'.repeat(90)}/${'e'.repeat(90)}/file.txt`;
    const tar = writeTar([f('index.html', '<h1>hi</h1>'), f('a/b.css', 'x'), f(long, 'deep'), { path: 'big.bin', data: randomBytes(5000) }]);
    const back = readTar(tar);
    expect(back.map((e) => e.path)).toEqual(['index.html', 'a/b.css', long, 'big.bin']);
    expect(back[2]!.data.toString()).toBe('deep');
    expect(back[3]!.data.length).toBe(5000);
  });

  it('reads GNU long names and flags links as other', () => {
    const h = (name: string, size: number, type: string) => {
      const b = Buffer.alloc(512);
      b.write(name, 0);
      b.write(size.toString(8).padStart(11, '0') + '\0', 124);
      b.write(type, 156);
      b.write('ustar  \0', 257);
      return b;
    };
    const longName = `./${'x'.repeat(150)}.html`;
    const body = Buffer.alloc(512);
    body.write(longName);
    const tar = Buffer.concat([h('././@LongLink', longName.length, 'L'), body, h('./short', 0, '0'), h('./link', 0, '2'), Buffer.alloc(1024)]);
    const e = readTar(tar);
    expect(e[0]!.path).toBe(longName);
    expect(e[1]!.type).toBe('other');
    expect(normalizeEntries(e).error).toMatch(/link or special file/);
  });

  it('rejects a truncated archive', () => {
    const tar = writeTar([f('index.html', 'x'.repeat(2000))]);
    expect(() => readTar(tar.subarray(0, 700))).toThrow(/truncated/);
  });
});

describe('bundle checks', () => {
  it('needs index.html and stays within limits', () => {
    expect(checkLimits([{ path: 'a.html', size: 1 }])).toMatch(/index\.html/);
    expect(checkLimits([{ path: 'index.html', size: 6 * 1024 * 1024 }])).toMatch(/5 MiB/);
    expect(checkLimits(Array.from({ length: 1001 }, (_, i) => ({ path: i ? `f${i}` : 'index.html', size: 1 })))).toMatch(/Too many/);
    expect(checkLimits(Array.from({ length: 6 }, (_, i) => ({ path: i ? `f${i}` : 'index.html', size: 4.9 * 1024 * 1024 })))).toMatch(/25 MiB/);
    expect(checkLimits([{ path: 'index.html', size: 10 }])).toBeNull();
  });

  it('drops reserved files and refuses path tricks', () => {
    const { files } = normalizeEntries([
      { path: './index.html', type: 'file', data: Buffer.from('x') },
      { path: './_headers', type: 'file', data: Buffer.from('x') },
      { path: './_redirects', type: 'file', data: Buffer.from('x') },
      { path: './sub/', type: 'dir', data: Buffer.alloc(0) },
    ]);
    expect(files.map((x) => x.path)).toEqual(['index.html']);
    expect(normalizeEntries([{ path: '../evil', type: 'file', data: Buffer.alloc(0) }]).error).toMatch(/bad path/);
  });
});

describe('form scan', () => {
  const refused = (path: string, text: string) => expect(scanForms([f(path, text)]), text).not.toBeNull();
  const fine = (path: string, text: string) => expect(scanForms([f(path, text)]), text).toBeNull();

  it('refuses password and card forms', () => {
    refused('index.html', '<form><input type="password" name="p"></form>');
    refused('index.html', "<input type='PASSWORD'>");
    refused('index.html', '<input autocomplete="cc-number">');
    refused('index.html', '<input name="card_number">');
    refused('index.html', '<input id="cvv" maxlength=4>');
    refused('index.html', '<input placeholder="IBAN">');
    refused('index.html', '<label for="x">Card number</label><input id="x">');
    refused('index.html', '<label>Password</label><input>');
    refused('index.html', '<input name="ssn">');
    refused('app.js', "const i = document.createElement('input'); i.type = 'password';");
    refused('app.js', "field({ name: 'cvc' })");
    refused('app.mjs', 'el.innerHTML = `<input type="password">`');
    refused('index.html', "<script>input.setAttribute('autocomplete', 'current-password')</script>");
  });

  it('lets normal pages through', () => {
    fine('index.html', '<form><input type="search" name="q" placeholder="Search"><button>Go</button></form>');
    fine('index.html', '<p>Never reuse your password. Use a password manager.</p>');
    fine('index.html', '<input type="email" name="email" placeholder="you@example.com">');
    fine('index.html', '<input name="passenger" placeholder="Passenger name">');
    fine('app.js', 'console.log("password reset docs at /help")');
    fine('style.css', 'input[type=password] { color: red }');
  });
});

describe('banner and headers', () => {
  it('injects the banner after <body> and noindex in <head>', () => {
    const out = injectBanner('<html><head><title>x</title></head><body class="a"><h1>x</h1></body></html>', bannerHtml(opts));
    expect(out).toMatch(/<head><meta name="robots" content="noindex, nofollow"><title>/);
    expect(out).toMatch(/<body class="a"><div id="smasnug-preview-banner"/);
    expect(out).toContain('Preview built by smasnug ai for @Ingo · expires 12:34 UTC · not affiliated with any site it imitates');
  });

  it('works without head/body and escapes names', () => {
    const out = injectBanner('<h1>bare</h1>', bannerHtml({ ...opts, requester: '<script>x</script>' }));
    expect(out.startsWith('<div id="smasnug-preview-banner"')).toBe(true);
    expect(out).not.toContain('<script>x</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('prepares a bundle: banners in every HTML file, our _headers', () => {
    const r = prepareBundle(readTar(writeTar([f('index.html', '<body>a</body>'), f('docs/p.htm', '<body>b</body>'), f('app.js', 'x'), f('_headers', 'evil')])), opts);
    if (!r.ok) throw new Error(r.reason);
    const by = Object.fromEntries(r.files.map((x) => [x.path, x.data.toString()]));
    expect(by['index.html']).toContain('smasnug-preview-banner');
    expect(by['docs/p.htm']).toContain('smasnug-preview-banner');
    expect(by['app.js']).toBe('x');
    expect(by['_headers']).toBe(HEADERS_FILE);
    expect(HEADERS_FILE).toContain("form-action 'none'");
    expect(HEADERS_FILE).toContain('X-Robots-Tag: noindex');
  });

  it('refuses and rejects bundles', () => {
    expect(prepareBundle(readTar(writeTar([f('index.html', '<input type=password>')])), opts)).toMatchObject({ ok: false, kind: 'refused' });
    expect(prepareBundle(readTar(writeTar([f('main.html', 'x')])), opts)).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('writes the wrangler config', () => {
    const w = JSON.parse(wranglerConfig({ name: 'smasnug-p-abc', withWorker: true }));
    expect(w).toMatchObject({ name: 'smasnug-p-abc', main: './worker.js', assets: { directory: './site', binding: 'ASSETS', run_worker_first: true } });
    expect(JSON.parse(wranglerConfig({ name: 'n', withWorker: false })).main).toBeUndefined();
  });
});

describe('secrets', () => {
  it('round-trips with AES-256-GCM and rejects tampering', () => {
    const key = randomBytes(32);
    const enc = encryptSecret('https://dash.cloudflare.com/claim?token=abc', key);
    expect(enc.toString('utf8')).not.toContain('claim');
    expect(decryptSecret(enc, key)).toBe('https://dash.cloudflare.com/claim?token=abc');
    enc[enc.length - 1]! ^= 1;
    expect(() => decryptSecret(enc, key)).toThrow();
    expect(() => previewKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('wrangler output parsing', () => {
  // Shaped like the spike's WRANGLER_OUTPUT_FILE_PATH output (docs/sandbox.md §9); values invented.
  const ND_FIXTURE = [
    '{"type":"wrangler-session","version":1,"wrangler_version":"4.99.0","command_line_args":["deploy","--temporary"],"log_file_path":"/tmp/h-pv_x/.config/.wrangler/logs/wrangler.log","timestamp":"2026-10-07T12:00:00.000Z"}',
    '{"type":"deploy","version":1,"worker_name":"smasnug-p-k3j9","worker_tag":"0f1e2d3c4b5a69788796a5b4c3d2e1f0","version_id":"7d1c2b3a-0000-4000-8000-123456789abc","targets":["https://smasnug-p-k3j9.tmp-quiet-river-42.workers.dev"],"worker_name_overridden":false,"bundle_size":2048,"timestamp":"2026-10-07T12:00:05.000Z"}',
    '',
  ].join('\n');
  const TOML_FIXTURE = `[account]
id = "0a1b2c3d4e5f60718293a4b5c6d7e8f9"
name = "Temporary account 1234"
apiToken = "tmpTok_EXAMPLE_0123456789abcdefghijklmnopqrstuv"
expiresAt = "2026-10-07T13:00:00.000Z"

[claim]
url = "https://dash.cloudflare.com/claim-temporary-account?token=EXAMPLEclaimTOKEN0123456789abcdef"
expiresAt = "2026-10-07T13:00:00.000Z"
`;

  it('reads the URL and worker name from the deploy record, skipping the session record', () => {
    expect(parseDeployRecord(ND_FIXTURE)).toEqual({ url: 'https://smasnug-p-k3j9.tmp-quiet-river-42.workers.dev', workerName: 'smasnug-p-k3j9' });
    expect(parseDeployUrl(ND_FIXTURE)).toBe('https://smasnug-p-k3j9.tmp-quiet-river-42.workers.dev');
    // The workers.dev target wins over other https targets; object targets are accepted.
    const multi = '{"type":"deploy","worker_name":"w","targets":["https://example.com/app","https://w.sub.workers.dev"]}';
    expect(parseDeployUrl(multi)).toBe('https://w.sub.workers.dev');
    expect(parseDeployUrl('{"type":"deploy","targets":[{"url":"https://w.sub.workers.dev"}]}')).toBe('https://w.sub.workers.dev');
    expect(parseDeployUrl('{"type":"deploy","targets":["example.com/*"]}')).toBeNull();
    expect(parseDeployUrl('{"type":"wrangler-session","version":1}')).toBeNull();
    expect(parseDeployRecord('garbage https://a.b.workers.dev/ more')).toEqual({ url: 'https://a.b.workers.dev', workerName: null });
    expect(parseDeployUrl('{}')).toBeNull();
  });

  it('reads the temporary account file (exact keys)', () => {
    const kv = parseSimpleToml(TOML_FIXTURE);
    expect(kv['account.id']).toBe('0a1b2c3d4e5f60718293a4b5c6d7e8f9');
    const a = pickTemporaryAccount(kv);
    expect(a).toEqual({
      accountId: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      apiToken: 'tmpTok_EXAMPLE_0123456789abcdefghijklmnopqrstuv',
      accountExpiresAt: new Date('2026-10-07T13:00:00.000Z'),
      claimUrl: 'https://dash.cloudflare.com/claim-temporary-account?token=EXAMPLEclaimTOKEN0123456789abcdef',
      claimExpiresAt: new Date('2026-10-07T13:00:00.000Z'),
    });
    // Dotted keys and an unquoted TOML datetime read the same; the claim shares the account's expiry when missing.
    const dotted = pickTemporaryAccount(parseSimpleToml('account.id = "acc"\naccount.apiToken = "tok"\naccount.expiresAt = 2026-10-07T13:00:00Z\nclaim.url = "https://c.example/x"'));
    expect(dotted).toMatchObject({ accountId: 'acc', apiToken: 'tok', claimUrl: 'https://c.example/x' });
    expect(dotted.claimExpiresAt?.toISOString()).toBe('2026-10-07T13:00:00.000Z');
    // Other spellings are not guessed at; a non-https claim URL is dropped.
    expect(pickTemporaryAccount(parseSimpleToml('[account]\naccount_id = "x"\napi_token = "y"\n[claim]\nurl = "javascript:x"'))).toEqual({
      accountId: null,
      apiToken: null,
      accountExpiresAt: null,
      claimUrl: null,
      claimExpiresAt: null,
    });
  });

  it('reads exactly the temporary account file, from XDG_CONFIG_HOME or elsewhere under HOME', () => {
    const root = mkdtempSync(join(tmpdir(), 'wr-'));
    try {
      const home = join(root, 'h');
      const xdg = join(home, '.config');
      const outFile = join(root, 'out.ndjson');
      const split = '\n----SPLIT----\n';
      writeFileSync(outFile, ND_FIXTURE);
      mkdirSync(join(xdg, '.wrangler'), { recursive: true });
      writeFileSync(join(xdg, '.wrangler', 'default.toml'), 'oauth_token = "not-this"\n');
      const run = () => execFileSync('bash', ['-c', readDeployOutputScript({ outFile, home, xdgConfigHome: xdg, split })]).toString('utf8');
      expect(run().split(split)).toEqual([ND_FIXTURE, '']);
      mkdirSync(join(home, 'elsewhere'), { recursive: true });
      writeFileSync(join(home, 'elsewhere', TEMP_ACCOUNT_FILE), TOML_FIXTURE.replace('Temporary account 1234', 'copy'));
      expect(run().split(split)[1]).toContain('name = "copy"');
      writeFileSync(join(xdg, '.wrangler', TEMP_ACCOUNT_FILE), TOML_FIXTURE);
      const [nd, acct] = run().split(split);
      expect(nd).toBe(ND_FIXTURE);
      expect(acct).toBe(TOML_FIXTURE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts claim links and tokens', () => {
    const r = redact('Claim it at https://dash.cloudflare.com/claim/abcdefg?x=1 token=supersecretvalue1234 and AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA done');
    expect(r).not.toMatch(/claim\/abc|supersecret|AAAAAAAA/);
    expect(r).toContain('done');
  });

  it("redacts wrangler's temporary account block and the account file", () => {
    const block = [
      'Uploaded smasnug-p-k3j9 (1.20 sec)',
      'Deployed smasnug-p-k3j9 triggers (0.50 sec)',
      '  https://smasnug-p-k3j9.tmp-quiet-river-42.workers.dev',
      'Temporary account ready',
      '  Account: Temporary account 1234 (0a1b2c3d4e5f60718293a4b5c6d7e8f9)',
      '  Claim URL: https://dash.cloudflare.com/x/ABCdef123',
      '  Claim this account within 60 minutes:',
      '    https://dash.example/a/Zq9x',
      '  Expires: 2026-10-07T13:00:00.000Z',
    ].join('\n');
    const r = redact(block + '\n' + TOML_FIXTURE);
    expect(r).not.toMatch(/ABCdef123|Zq9x|0a1b2c3d4e5f60718293a4b5c6d7e8f9|tmpTok_EXAMPLE|EXAMPLEclaimTOKEN|dash\.cloudflare\.com\/x/);
    // Only the preview URL itself survives.
    expect(r.match(/https:\/\/\S+/g)).toEqual(['https://smasnug-p-k3j9.tmp-quiet-river-42.workers.dev']);
    expect(r).toContain('Temporary account ready');
  });
});

describe('preview messages', () => {
  const row = { id: 'pv_abc', title: 'My *page*', requesterId: 'U1', url: 'https://x.y.workers.dev', expiresAt: new Date('2026-10-07T12:00:00Z') } as any;
  it('has the claim + report buttons and never a claim URL', () => {
    const m = previewMessage(row);
    const json = JSON.stringify(m);
    expect(json).toContain('preview:claim');
    expect(json).toContain('preview:report');
    expect(json).toContain('Only <@U1> can claim it');
    expect(json).not.toMatch(/claim\//);
    expect(m.text).toContain('https://x.y.workers.dev');
  });
  it('terms prompt names Cloudflare with Accept / Cancel', () => {
    const json = JSON.stringify(termsBlocks(row));
    expect(json).toContain('Cloudflare');
    expect(json).toContain('preview:terms_accept');
    expect(json).toContain('preview:terms_cancel');
    expect(json).toContain('cloudflare.com/terms');
    expect(json).toContain('privacypolicy');
  });
});
