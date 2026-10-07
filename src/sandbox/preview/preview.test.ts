import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { bannerHtml, checkLimits, HEADERS_FILE, injectBanner, normalizeEntries, prepareBundle, scanForms, wranglerConfig } from './bundle.js';
import { decryptSecret, encryptSecret, previewKey } from './crypto.js';
import { parseDeployUrl, parseSimpleToml, pickTemporaryAccount, redact } from './deploy.js';
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
  it('finds the URL in the ND-JSON output', () => {
    const nd = ['{"type":"wrangler-session","version":1}', '{"type":"deploy","version":1,"worker_name":"smasnug-p-x","targets":["https://smasnug-p-x.tmp-abc.workers.dev"]}'].join('\n');
    expect(parseDeployUrl(nd)).toBe('https://smasnug-p-x.tmp-abc.workers.dev');
    expect(parseDeployUrl('garbage https://a.b.workers.dev/ more')).toBe('https://a.b.workers.dev');
    expect(parseDeployUrl('{}')).toBeNull();
  });

  it('reads the temporary account file', () => {
    const toml = `# generated
[account]
id = "acc123"
api_token = "tok_secret"
expires_at = "2026-10-07T13:00:00Z"

[claim]
url = "https://dash.cloudflare.com/claim/xyz"
expires_at = "2026-10-07T13:00:00Z"
`;
    const kv = parseSimpleToml(toml);
    expect(kv['account.id']).toBe('acc123');
    const a = pickTemporaryAccount(kv);
    expect(a).toMatchObject({ accountId: 'acc123', apiToken: 'tok_secret', claimUrl: 'https://dash.cloudflare.com/claim/xyz' });
    expect(a.accountExpiresAt?.toISOString()).toBe('2026-10-07T13:00:00.000Z');
    expect(a.claimExpiresAt?.toISOString()).toBe('2026-10-07T13:00:00.000Z');
  });

  it('redacts claim links and tokens', () => {
    const r = redact('Claim it at https://dash.cloudflare.com/claim/abcdefg?x=1 token=supersecretvalue1234 and AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA done');
    expect(r).not.toMatch(/claim\/abc|supersecret|AAAAAAAA/);
    expect(r).toContain('done');
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
