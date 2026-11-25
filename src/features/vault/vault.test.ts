import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openFor, sealFor, userKey } from './crypto.js';
import { scrubText } from './scrub.js';
import { hostAllowed, normalizeName, parseDomains, validName } from './store.js';
import { base32Decode, parseTotp, totpCode, validTotp } from './totp.js';
import { openViewState, sealViewState } from './transport.js';

const KEY = randomBytes(32).toString('base64');

describe('vault crypto', () => {
  it('derives a different key per user and round-trips', () => {
    expect(userKey('U1', KEY).equals(userKey('U2', KEY))).toBe(false);
    const blob = sealFor('U1', 'hunter2', KEY);
    expect(openFor('U1', blob, KEY)).toBe('hunter2');
    expect(() => openFor('U2', blob, KEY)).toThrow();
  });
});

describe('totp', () => {
  // RFC 6238 appendix B, SHA-1 seed "12345678901234567890".
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches the RFC test vectors (6 digits)', () => {
    expect(base32Decode(seed).toString()).toBe('12345678901234567890');
    expect(totpCode(seed, 59_000).code).toBe('287082');
    expect(totpCode(seed, 1111111109_000).code).toBe('081804');
    expect(totpCode(seed, 1234567890_000).code).toBe('005924');
  });
  it('reads otpauth URIs', () => {
    const uri = `otpauth://totp/Example:me?secret=${seed}&issuer=Example&digits=8`;
    expect(parseTotp(uri).digits).toBe(8);
    expect(totpCode(uri, 59_000).code).toBe('94287082');
    expect(validTotp('otpauth://hotp/x?secret=AAAA')).toBe(false);
    expect(validTotp('not a seed!')).toBe(false);
    expect(validTotp('JBSW Y3DP EHPK 3PXP')).toBe(true);
  });
});

describe('names and domains', () => {
  it('normalizes and validates names', () => {
    expect(normalizeName(' My Key ')).toBe('my-key');
    expect(validName('github')).toBe(true);
    expect(validName('-x')).toBe(false);
    expect(validName('a:b')).toBe(false);
  });
  it('parses domains from hosts and URLs', () => {
    expect(parseDomains('https://API.GitHub.com/x, *.example.org  bad_host')).toEqual(['api.github.com', 'example.org']);
    expect(parseDomains('')).toEqual([]);
  });
  it('matches hosts and subdomains only', () => {
    expect(hostAllowed('api.github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('github.com.', ['github.com'])).toBe(true);
    expect(hostAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(hostAllowed('github.com.evil.io', ['github.com'])).toBe(false);
    expect(hostAllowed('x.com', undefined)).toBe(false);
  });
});

describe('scrubText', () => {
  it('redacts the secret and its common encodings', () => {
    const s = [{ name: 'gh', value: 'ghp_abc/123+=' }];
    const b64 = Buffer.from('ghp_abc/123+=').toString('base64');
    const out = scrubText(`token ghp_abc/123+= url ${encodeURIComponent('ghp_abc/123+=')} b64 ${b64}`, s);
    expect(out).not.toContain('ghp_abc');
    expect(out).not.toContain(b64);
    expect(out.match(/\[redacted:gh\]/g)?.length).toBe(3);
  });
  it('ignores very short secrets and empty input', () => {
    expect(scrubText('abc', [{ name: 'x', value: 'ab' }])).toBe('abc');
    expect(scrubText('', [{ name: 'x', value: 'secret' }])).toBe('');
  });
});

describe('modal transport sealing', () => {
  it('seals vault modal state and opens it again', async () => {
    process.env.VAULT_SECRET_KEY = KEY;
    // config reads env at import: re-import with the key set.
    const { vi } = await import('vitest');
    vi.resetModules();
    const t = await import('./transport.js');
    const body = { type: 'view_submission', view: { callback_id: 'vaultm:save', state: { values: { secret: { v: { value: 'pw' } } } } } };
    t.sealViewState(body);
    expect(JSON.stringify(body)).not.toContain('pw');
    expect(t.openViewState(body).values?.secret?.v?.value).toBe('pw');
  });
  it('leaves other modals alone', () => {
    const body = { type: 'view_submission', view: { callback_id: 'report:x', state: { values: { a: { v: { value: 'x' } } } } } };
    sealViewState(body);
    expect(openViewState(body).values?.a?.v?.value).toBe('x');
  });
});
