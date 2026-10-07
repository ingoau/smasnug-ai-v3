import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { formatExecResult, safeBaseName, showStream, splitWrapped } from './format.js';
import { shq, workPath } from './provider.js';

describe('workPath', () => {
  it('keeps paths under /work', () => {
    expect(workPath('out/a.png')).toBe('/work/out/a.png');
    expect(workPath('/work/x/../y')).toBe('/work/y');
    expect(workPath('./a//b/')).toBe('/work/a/b');
    expect(workPath('/work')).toBe('/work');
  });
  it('refuses escapes and other roots', () => {
    expect(workPath('../etc/passwd')).toBeNull();
    expect(workPath('/etc/passwd')).toBeNull();
    expect(workPath('/work/../etc')).toBeNull();
    expect(workPath('/workspace/x')).toBeNull();
    expect(workPath('')).toBeNull();
    expect(workPath('a\0b')).toBeNull();
  });
  it('quotes for bash', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

describe('exec output', () => {
  it('passes short output through', () => {
    const p = splitWrapped(Buffer.from('hello\n'));
    expect(p).toEqual({ head: 'hello\n', totalBytes: null, tail: '' });
    expect(showStream('stdout', p)).toBe('hello\n');
  });

  it('cuts wrapped long output to head + tail with a note', () => {
    const head = 'H'.repeat(8192);
    const tail = 'T'.repeat(32768);
    const p = splitWrapped(Buffer.from(`${head}\n\u0000SBXCUT 500000\u0000\n${tail}`));
    expect(p.totalBytes).toBe(500000);
    const shown = showStream('stdout', p, 2000, 10000);
    expect(shown.startsWith('H'.repeat(2000) + '\n[… ')).toBe(true);
    expect(shown).toContain('bytes cut; full output in /work/.last/stdout]');
    expect(shown.endsWith('T'.repeat(10000))).toBe(true);
    expect(shown).toContain(`${500000 - 12000} bytes cut`);
  });

  it('cuts unwrapped but long output too', () => {
    const shown = showStream('stderr', splitWrapped(Buffer.from('a'.repeat(20000))), 100, 100);
    expect(shown).toContain('19800 bytes cut; full output in /work/.last/stderr');
  });

  it('formats status lines', () => {
    const base = { exitCode: 0, timedOut: false, aborted: false, durationMs: 1234, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), timeoutS: 60 };
    expect(formatExecResult(base)).toBe('exit code 0, 1.2s\nstdout:\nok');
    expect(formatExecResult({ ...base, exitCode: 124, timedOut: true })).toMatch(/^timed out after 60s/);
    expect(formatExecResult({ ...base, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') })).toBe('exit code 0, 1.2s\nstdout: (empty)\nstderr:\nboom');
  });

  it('makes safe import names', () => {
    expect(safeBaseName('../../etc/passwd')).toBe('passwd');
    expect(safeBaseName('.hidden')).toBe('hidden');
    expect(safeBaseName('a b(1).csv')).toBe('a b(1).csv');
    expect(safeBaseName('weird\u0001name$.txt')).toBe('weirdname_.txt');
    expect(safeBaseName('')).toBe('file');
  });
});
