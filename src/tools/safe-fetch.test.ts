import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockedUrlError, checkUrl, isBlockedIp, redirectMethod, safeFetch, SINK_SKIPPED_MAX_BYTES } from './safe-fetch.js';

const base = { maxBytes: 1024 * 1024, timeoutMs: 3000 };

/** DNS stub: maps hostnames to fixed addresses (the agent still validates the result). */
function stubLookup(map: Record<string, string>) {
  return ((hostname: string, options: any, cb: any) => {
    const address = map[hostname];
    if (!address) return cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    const family = address.includes(':') ? 6 : 4;
    if (options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as any;
}

let server: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/ok') return res.end('hello');
    if (u.pathname === '/redirect') {
      res.writeHead(302, { location: u.searchParams.get('to')! });
      return res.end();
    }
    if (u.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    if (u.pathname === '/big') return res.end('x'.repeat(5000));
    if (u.pathname === '/gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
      return res.end(zlib.gzipSync('compressed body'));
    }
    if (u.pathname === '/slow') return setTimeout(() => res.end('late'), 2000);
    if (u.pathname === '/auth') return res.end(req.headers.authorization ?? 'none');
    if (u.pathname === '/bigerror') return void res.writeHead(500, { 'content-type': 'text/html' }).end('e'.repeat(200_000));
    if (u.pathname === '/blob') return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(200_000, 3));
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function expectBlocked(url: string, extra: object = {}) {
  const before = hits;
  await expect(safeFetch(url, { ...base, ...extra })).rejects.toBeInstanceOf(BlockedUrlError);
  expect(hits).toBe(before); // nothing reached the local server
}

describe('safeFetch SSRF protection', () => {
  it('blocks localhost and loopback literals', async () => {
    await expectBlocked(`http://localhost:${port}/ok`);
    await expectBlocked(`http://127.0.0.1:${port}/ok`);
    await expectBlocked(`http://[::1]:${port}/ok`);
    await expectBlocked(`http://foo.localhost:${port}/ok`);
  });

  it('blocks obfuscated / mapped loopback forms', async () => {
    await expectBlocked(`http://2130706433:${port}/ok`); // decimal 127.0.0.1
    await expectBlocked(`http://0x7f000001:${port}/ok`);
    await expectBlocked(`http://127.1:${port}/ok`);
    await expectBlocked(`http://[::ffff:127.0.0.1]:${port}/ok`);
    await expectBlocked(`http://[::ffff:7f00:1]:${port}/ok`);
    await expectBlocked(`http://0.0.0.0:${port}/ok`);
  });

  it('blocks cloud metadata, private, CGNAT and IPv6 local ranges', async () => {
    for (const host of ['169.254.169.254', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '100.64.0.1', '[fd00::1]', '[fc00::1]', '[fe80::1]', '[::]']) {
      await expectBlocked(`http://${host}/latest/meta-data`);
    }
  });

  it('blocks non-http schemes and credentials', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'data:text/plain,hi', 'https://user:pw@example.com/']) {
      await expectBlocked(u);
    }
  });

  it('blocks a hostname that resolves to a private IP (checked at connect time)', async () => {
    await expectBlocked(`http://evil.example:${port}/ok`, { lookup: stubLookup({ 'evil.example': '127.0.0.1' }) });
    await expectBlocked('http://meta.example/', { lookup: stubLookup({ 'meta.example': '169.254.169.254' }) });
    await expectBlocked('http://v6.example/', { lookup: stubLookup({ 'v6.example': '::1' }) });
    await expectBlocked('http://mapped.example/', { lookup: stubLookup({ 'mapped.example': '::ffff:10.0.0.1' }) });
    await expectBlocked('http://cgnat.example/', { lookup: stubLookup({ 'cgnat.example': '100.100.1.1' }) });
  });

  it('allows the (test-allowlisted) server and follows safe redirects', async () => {
    const allow = { allowIPAddressList: ['127.0.0.1'] };
    const ok = await safeFetch(`http://127.0.0.1:${port}/ok`, { ...base, ...allow });
    expect(ok.body.toString()).toBe('hello');
    const red = await safeFetch(`http://127.0.0.1:${port}/redirect?to=/ok`, { ...base, ...allow });
    expect(red.body.toString()).toBe('hello');
    expect(red.url).toBe(`http://127.0.0.1:${port}/ok`);
  });

  it('re-checks every redirect hop: redirect to a private address is blocked', async () => {
    const allow = { allowIPAddressList: ['127.0.0.1'] };
    const start = `http://127.0.0.1:${port}/redirect?to=`;
    await expect(safeFetch(start + encodeURIComponent('http://169.254.169.254/latest/meta-data'), { ...base, ...allow })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(safeFetch(start + encodeURIComponent('http://10.1.2.3/'), { ...base, ...allow })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(safeFetch(start + encodeURIComponent('http://localhost/'), { ...base, ...allow })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      safeFetch(start + encodeURIComponent('http://internal.example/'), { ...base, ...allow, lookup: stubLookup({ 'internal.example': '192.168.0.10' }) }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(safeFetch(start + encodeURIComponent('file:///etc/passwd'), { ...base, ...allow })).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('caps redirects, bytes and time', async () => {
    const allow = { allowIPAddressList: ['127.0.0.1'] };
    await expect(safeFetch(`http://127.0.0.1:${port}/loop`, { ...base, ...allow })).rejects.toThrow(/too many redirects/);
    const big = await safeFetch(`http://127.0.0.1:${port}/big`, { ...base, ...allow, maxBytes: 1000 });
    expect(big.body.length).toBe(1000);
    expect(big.truncated).toBe(true);
    await expect(safeFetch(`http://127.0.0.1:${port}/slow`, { ...base, ...allow, timeoutMs: 300 })).rejects.toThrow(/timed out|abort/i);
    const gz = await safeFetch(`http://127.0.0.1:${port}/gzip`, { ...base, ...allow });
    expect(gz.body.toString()).toBe('compressed body');
  });

  it('drops auth headers on cross-origin redirects', async () => {
    const allow = { allowIPAddressList: ['127.0.0.1'] };
    const origin = `http://127.0.0.1:${port}`;
    const same = await safeFetch(`${origin}/auth`, { ...base, ...allow, headers: { authorization: 'Bearer x' }, authOrigin: origin });
    expect(same.body.toString()).toBe('Bearer x');
    const other = await safeFetch(`${origin}/auth`, { ...base, ...allow, headers: { authorization: 'Bearer x' }, authOrigin: 'https://files.slack.com' });
    expect(other.body.toString()).toBe('none');
  });
});

describe('safeFetch with a sink', () => {
  const allow = { allowIPAddressList: ['127.0.0.1'] };
  const collector = () => {
    const parts: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        parts.push(chunk);
        cb();
      },
    });
    return { sink, got: () => Buffer.concat(parts) };
  };

  it('streams a 2xx body to the sink', async () => {
    const c = collector();
    const r = await safeFetch(`http://127.0.0.1:${port}/blob`, { ...base, ...allow, sink: c.sink });
    expect(r).toMatchObject({ status: 200, sunk: true, streamedBytes: 200_000, truncated: false });
    expect(r.body.length).toBe(0);
    expect(c.got().length).toBe(200_000);
  });

  it('never sinks an error response: a short buffered body instead', async () => {
    const c = collector();
    const r = await safeFetch(`http://127.0.0.1:${port}/bigerror`, { ...base, ...allow, sink: c.sink });
    expect(r).toMatchObject({ status: 500, sunk: false, streamedBytes: 0, truncated: true });
    expect(r.body.length).toBe(SINK_SKIPPED_MAX_BYTES);
    expect(c.got().length).toBe(0);
  });

  it('sinkIf sees the headers before any byte is written; a throw aborts', async () => {
    const c = collector();
    const seen: string[] = [];
    const p = safeFetch(`http://127.0.0.1:${port}/blob`, {
      ...base,
      ...allow,
      sink: c.sink,
      sinkIf: ({ contentType }) => {
        seen.push(contentType);
        throw new Error('not this one');
      },
    });
    await expect(p).rejects.toThrow('not this one');
    expect(seen).toEqual(['application/octet-stream']);
    expect(c.got().length).toBe(0);
  });

  it('a failing sink rejects the fetch (no hang, no unhandled error)', async () => {
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, cb) {
        setTimeout(() => cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })), 5);
      },
    });
    await expect(safeFetch(`http://127.0.0.1:${port}/blob`, { ...base, ...allow, sink })).rejects.toThrow('ENOSPC');
  });
});

describe('checkUrl / isBlockedIp', () => {
  it('classifies addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
    for (const ip of ['127.0.0.1', '10.1.1.1', '172.20.0.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '0.0.0.0', '255.255.255.255', '224.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    expect(checkUrl('https://example.com/a').hostname).toBe('example.com');
  });
});

describe('redirectMethod (requests without a body)', () => {
  it('keeps GET/HEAD, turns POST on 301/302 and anything on 303 into GET', () => {
    expect(redirectMethod('GET', 307)).toBe('GET');
    expect(redirectMethod('HEAD', 301)).toBe('HEAD');
    expect(redirectMethod('POST', 302)).toBe('GET');
    expect(redirectMethod('POST', 301)).toBe('GET');
    expect(redirectMethod('DELETE', 303)).toBe('GET');
  });

  it('refuses to replay other methods at another address', () => {
    expect(() => redirectMethod('DELETE', 302)).toThrow(BlockedUrlError);
    expect(() => redirectMethod('PUT', 301)).toThrow(BlockedUrlError);
    expect(() => redirectMethod('POST', 307)).toThrow(BlockedUrlError);
    expect(() => redirectMethod('PATCH', 308)).toThrow(BlockedUrlError);
  });
});
