import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { normalizeOpenUrl, originOf, urlVerdict } from './policy.js';

const open = { deny: [], allow: [] };

describe('normalizeOpenUrl', () => {
  it('adds https:// to bare hosts and keeps schemes', () => {
    expect(normalizeOpenUrl('example.com/x')).toBe('https://example.com/x');
    expect(normalizeOpenUrl(' http://a.test ')).toBe('http://a.test');
    expect(normalizeOpenUrl('file:///work/site/index.html')).toBe('file:///work/site/index.html');
    expect(normalizeOpenUrl('about:blank')).toBe('about:blank');
    expect(normalizeOpenUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(normalizeOpenUrl('localhost:3000')).toBe('https://localhost:3000');
  });
});

describe('urlVerdict', () => {
  it('allows public http(s) and reports host and path without the query', () => {
    expect(urlVerdict('https://www.example.com/a/b?token=x#f', open)).toEqual({ ok: true, host: 'www.example.com', path: '/a/b', https: true });
    expect(urlVerdict('http://example.com', open)).toMatchObject({ ok: true, https: false });
  });
  it('blocks private and local addresses (checkUrl)', () => {
    for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest', 'http://localhost:3000/', 'http://router.local/', 'http://[::1]/', 'https://user:pw@example.com/']) {
      expect(urlVerdict(u, open).ok, u).toBe(false);
    }
  });
  it('applies the deny list (subdomains included)', () => {
    const pol = { deny: ['evil.test'], allow: [] };
    expect(urlVerdict('https://evil.test/', pol)).toMatchObject({ ok: false, host: 'evil.test' });
    expect(urlVerdict('https://a.b.evil.test/', pol).ok).toBe(false);
    expect(urlVerdict('https://notevil.test/', pol).ok).toBe(true);
  });
  it('applies the allow list when set', () => {
    const pol = { deny: [], allow: ['example.com'] };
    expect(urlVerdict('https://docs.example.com/', pol).ok).toBe(true);
    const v = urlVerdict('https://other.test/', pol);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/only these sites/);
  });
  it('deny wins over allow', () => {
    expect(urlVerdict('https://bad.example.com/', { deny: ['bad.example.com'], allow: ['example.com'] }).ok).toBe(false);
  });
  it('allows about:blank, the error page and files under /work only', () => {
    expect(urlVerdict('about:blank', open)).toMatchObject({ ok: true, host: null });
    expect(urlVerdict('chrome-error://chromewebdata/', open).ok).toBe(true);
    expect(urlVerdict('file:///work/site/index.html', open)).toMatchObject({ ok: true, host: null, path: '/work/site/index.html' });
    for (const u of ['file:///etc/passwd', 'file:///work/../etc/passwd', 'file://host/work/x', 'data:text/html,hi', 'javascript:alert(1)', 'chrome://settings', 'view-source:https://a.test', 'ftp://a.test/', 'not a url']) {
      expect(urlVerdict(u, open).ok, u).toBe(false);
    }
  });
});

describe('originOf', () => {
  it('gives the origin of http(s) pages only', () => {
    expect(originOf('https://a.test:8443/x?y')).toBe('https://a.test:8443');
    expect(originOf('about:blank')).toBeNull();
  });
});
