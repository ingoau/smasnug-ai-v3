import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { STDIN_CHUNK_BYTES, writeStdinChunked } from './modal.js';

/** A stdin like the SDK's: one async "RPC" per write with a running offset, then an eof on close. */
function fakeStdin(maxWrite: number) {
  const writes: { offset: number; len: number }[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  let closed = false;
  const stream = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (chunk.byteLength > maxWrite) throw new Error('OUT_OF_RANGE: Error, decoded message length too large');
      // Uneven latency: order must still hold.
      await new Promise((r) => setTimeout(r, chunk.byteLength % 3));
      writes.push({ offset, len: chunk.byteLength });
      parts.push(new Uint8Array(chunk));
      offset += chunk.byteLength;
    },
    async close() {
      closed = true;
    },
  });
  return { stream, writes, joined: () => Buffer.concat(parts), isClosed: () => closed };
}

describe('writeStdinChunked', () => {
  it('sends a big buffer as ordered chunks no larger than the chunk size, then closes', async () => {
    const bytes = Buffer.alloc(10 * 1024 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    const s = fakeStdin(4096);
    await writeStdinChunked(s.stream, bytes, 4096);
    expect(s.writes.map((w) => w.len)).toEqual([4096, 4096, 2055]);
    expect(s.writes.map((w) => w.offset)).toEqual([0, 4096, 8192]);
    expect(s.joined().equals(bytes)).toBe(true);
    expect(s.isClosed()).toBe(true);
  });

  it('writes a buffer at a non-zero offset of a shared ArrayBuffer correctly', async () => {
    const pool = Buffer.from('xxxxhello worldyyyy');
    const view = pool.subarray(4, 15);
    const s = fakeStdin(4);
    await writeStdinChunked(s.stream, new Uint8Array(view.buffer, view.byteOffset, view.byteLength), 4);
    expect(s.joined().toString()).toBe('hello world');
  });

  it('defaults to chunks well under the provider message cap', async () => {
    expect(STDIN_CHUNK_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
    const s = fakeStdin(STDIN_CHUNK_BYTES);
    await writeStdinChunked(s.stream, new Uint8Array(STDIN_CHUNK_BYTES * 2 + 1));
    expect(s.writes.length).toBe(3);
  });

  it('propagates a failed write', async () => {
    const s = fakeStdin(2);
    await expect(writeStdinChunked(s.stream, new Uint8Array(8), 4)).rejects.toThrow(/OUT_OF_RANGE/);
  });
});
