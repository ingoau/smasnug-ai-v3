/** Large files, pure parts: tier decisions, limit texts, staging (stream + download) and the streamed upload POST. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { limits } from '../config.js';
import { formatBytes } from './format.js';
import { LargeFileRefusedError, postFileTo, removeStaleTempDirs, stageDownload, stageStream, storageTier, TooLargeError, tooLargeText, transferTimeoutMs, type LargeGate } from './large.js';

/** A gate that records its calls (the real one needs Redis: large.int.test.ts). */
function fakeGate(threshold: number, allowed: number | Error) {
  const calls: { reserve: (number | null)[]; finish: number[] } = { reserve: [], finish: [] };
  const gate: LargeGate = {
    threshold,
    async reserve(expected) {
      calls.reserve.push(expected);
      if (allowed instanceof Error) throw allowed;
      return { allowed, overError: () => new LargeFileRefusedError('over the budget') };
    },
    async finish(n) {
      calls.finish.push(n);
    },
  };
  return { gate, calls };
}

const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('limits', () => {
  it('storageTier: Postgres up to the store cap, a large file up to Slack, else refused', () => {
    expect(storageTier(0, 10, 100)).toBe('store');
    expect(storageTier(10, 10, 100)).toBe('store');
    expect(storageTier(11, 10, 100)).toBe('large');
    expect(storageTier(100, 10, 100)).toBe('large');
    expect(storageTier(101, 10, 100)).toBe('too_large');
    // The prod case: a 176 MB .pptx and a 405 MB .key are postable, a 2 GB file isn't.
    expect(storageTier(176 * MB)).toBe('large');
    expect(storageTier(405 * MB)).toBe('large');
    expect(storageTier(2048 * MB)).toBe('too_large');
    expect(storageTier(limits.fileMaxBytes)).toBe('store');
  });

  it('tooLargeText names the real limit and the alternatives', () => {
    const t = tooLargeText('/work/deck.key', 2048 * MB);
    expect(t).toContain('2.0 GB');
    expect(t).toContain(formatBytes(limits.largeFileMaxBytes));
    expect(t).toMatch(/Slack's upload limit/);
    expect(t).toMatch(/split it|link/);
    expect(tooLargeText('the file', null)).toContain(`larger than ${formatBytes(limits.largeFileMaxBytes)}`);
  });

  it('formatBytes switches to GB near 1 GB', () => {
    expect(formatBytes(405 * MB)).toBe('405.0 MB');
    expect(formatBytes(limits.largeFileMaxBytes)).toBe('1.0 GB');
  });

  it('transferTimeoutMs grows with size, within [1 min, 30 min]', () => {
    expect(transferTimeoutMs(0)).toBe(60_000);
    expect(transferTimeoutMs(405 * MB)).toBeGreaterThan(transferTimeoutMs(176 * MB));
    expect(transferTimeoutMs(1024 * MB)).toBeLessThanOrEqual(30 * 60_000);
  });
});

describe('staging', () => {
  it('stageStream writes chunks to disk with size, hash and head', async () => {
    const parts = [Buffer.alloc(3000, 1), Buffer.alloc(3000, 2), Buffer.from('end')];
    async function* gen() {
      for (const p of parts) yield new Uint8Array(p);
    }
    const s = await stageStream(gen(), 10_000);
    try {
      const all = Buffer.concat(parts);
      expect(s.size).toBe(all.length);
      expect(s.sha256).toBe(sha(all));
      expect(s.head.length).toBe(4096);
      expect(s.head.equals(all.subarray(0, 4096))).toBe(true);
      expect((await readFile(s.path)).equals(all)).toBe(true);
    } finally {
      await s.cleanup();
    }
    await expect(stat(s.path)).rejects.toThrow();
  });

  it('stageStream refuses past the cap and leaves nothing behind', async () => {
    async function* gen() {
      yield new Uint8Array(600);
      yield new Uint8Array(600);
    }
    await expect(stageStream(gen(), 1000)).rejects.toBeInstanceOf(TooLargeError);
  });

  it('stageStream passes a failing source through', async () => {
    async function* gen(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(10);
      throw new Error('No such file: /work/x');
    }
    await expect(stageStream(gen(), 1000)).rejects.toThrow('No such file');
  });
});

describe('staging with a gate', () => {
  async function* chunks(n: number, size: number) {
    for (let i = 0; i < n; i++) yield new Uint8Array(size);
  }

  it('reserves once, on crossing the threshold, and charges what was staged', async () => {
    const { gate, calls } = fakeGate(1000, 10_000);
    const s = await stageStream(chunks(5, 600), 10_000, { gate });
    expect(calls.reserve).toEqual([null]);
    await s.cleanup();
    expect(calls.finish).toEqual([3000]);
  });

  it('under the threshold: no reservation', async () => {
    const { gate, calls } = fakeGate(1000, 10_000);
    const s = await stageStream(chunks(1, 600), 10_000, { gate });
    await s.cleanup();
    expect(calls.reserve).toEqual([]);
  });

  it('a lower allowance cuts the staging with its own error', async () => {
    const { gate } = fakeGate(1000, 2000);
    await expect(stageStream(chunks(5, 600), 10_000, { gate })).rejects.toThrow('over the budget');
  });

  it('a known size past the threshold is checked before anything is read', async () => {
    const { gate, calls } = fakeGate(1000, new LargeFileRefusedError('busy'));
    let read = false;
    async function* src() {
      read = true;
      yield new Uint8Array(10);
    }
    await expect(stageStream(src(), 10_000, { gate, expected: 5000 })).rejects.toThrow('busy');
    expect(read).toBe(false);
    expect(calls.reserve).toEqual([5000]);
  });

  it('removeStaleTempDirs removes only old staging dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'large-test-'));
    try {
      await mkdir(join(dir, 'smasnug-file-old'));
      await mkdir(join(dir, 'smasnug-file-new'));
      await mkdir(join(dir, 'other-old'));
      const old = new Date(Date.now() - 2 * 86_400_000);
      await utimes(join(dir, 'smasnug-file-old'), old, old);
      await utimes(join(dir, 'other-old'), old, old);
      expect(await removeStaleTempDirs(86_400_000, dir)).toBe(1);
      expect((await readdir(dir)).sort()).toEqual(['other-old', 'smasnug-file-new']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('over HTTP', () => {
  let server: http.Server;
  let base = '';
  const body = Buffer.alloc(200_000);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const received: { headers: http.IncomingHttpHeaders; body: Buffer }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          received.push({ headers: req.headers, body: Buffer.concat(chunks) });
          res.writeHead(req.url === '/fail' ? 500 : 200).end('OK');
        });
        return;
      }
      if (req.url === '/file') return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
      if (req.url === '/missing') return void res.writeHead(404).end('nope');
      if (req.url === '/sized') return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) }).end(body);
      if (req.url === '/error-page') return void res.writeHead(500, { 'content-type': 'text/html' }).end('<html>' + 'x'.repeat(300_000));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const dl = (path: string, maxBytes: number) => stageDownload(`${base}${path}`, { maxBytes, timeoutMs: 5000, allowIPAddressList: ['127.0.0.1'] });

  it('stageDownload streams the body to disk (exactly the cap is fine)', async () => {
    const { res, staged } = await dl('/file', body.length);
    try {
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
      expect(staged.size).toBe(body.length);
      expect(staged.sha256).toBe(sha(body));
      expect((await readFile(staged.path)).equals(body)).toBe(true);
    } finally {
      await staged.cleanup();
    }
  });

  it('stageDownload: one byte over the cap → TooLargeError', async () => {
    await expect(dl('/file', body.length - 1)).rejects.toBeInstanceOf(TooLargeError);
  });

  it('stageDownload returns error statuses to the caller', async () => {
    const { res, staged } = await dl('/missing', 1000);
    await staged.cleanup();
    expect(res.status).toBe(404);
  });

  it('stageDownload never writes an error response to disk', async () => {
    const { res, staged } = await dl('/error-page', 10 * 1024 * 1024);
    try {
      expect(res.status).toBe(500);
      expect(staged.size).toBe(0);
      expect((await stat(staged.path)).size).toBe(0);
    } finally {
      await staged.cleanup();
    }
  });

  it('stageDownload: a Content-Length past the threshold reserves before the body; one over the cap is refused', async () => {
    const { gate, calls } = fakeGate(1000, new LargeFileRefusedError('no budget left'));
    await expect(stageDownload(`${base}/sized`, { maxBytes: body.length, timeoutMs: 5000, allowIPAddressList: ['127.0.0.1'], gate })).rejects.toThrow('no budget left');
    expect(calls.reserve).toEqual([body.length]);
    await expect(dl('/sized', 1000)).rejects.toBeInstanceOf(TooLargeError);
  });

  it('postFileTo streams a file with its Content-Length; non-2xx throws', async () => {
    const { staged } = await dl('/file', body.length);
    try {
      await postFileTo(`${base}/up`, staged.path, staged.size, 'application/vnd.ms-powerpoint', { timeoutMs: 5000 });
      const got = received.at(-1)!;
      expect(got.headers['content-length']).toBe(String(body.length));
      expect(got.headers['content-type']).toBe('application/vnd.ms-powerpoint');
      expect(got.body.equals(body)).toBe(true);
      await expect(postFileTo(`${base}/fail`, staged.path, staged.size, 'application/octet-stream', { timeoutMs: 5000 })).rejects.toThrow('HTTP 500');
    } finally {
      await staged.cleanup();
    }
  });
});
