/**
 * Minimal tar reader/writer for preview bundles (pure, no dependencies). Reads ustar/GNU/pax archives as produced by
 * GNU tar (regular files and directories; long names via pax `path` or GNU `L`); everything else (symlinks, devices)
 * is reported as `other` so the caller can refuse it. Writes plain ustar.
 */

export interface TarEntry {
  path: string;
  type: 'file' | 'dir' | 'other';
  data: Buffer;
}

const BLOCK = 512;

function str(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

function octal(b: Buffer, off: number, len: number): number {
  // GNU base-256 for big sizes.
  if (b[off]! & 0x80) {
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i]!;
    return v;
  }
  const s = str(b, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString('utf8'), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | undefined;
  let pax: Record<string, string> = {};
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156]! || 48);
    const magic = str(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? str(h, 345, 155) : '';
    let name = str(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = off + BLOCK;
    if (dataStart + size > buf.length) throw new Error('truncated tar archive');
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    const path = pax.path ?? longName ?? name;
    longName = undefined;
    pax = {};
    const kind: TarEntry['type'] = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : 'other';
    out.push({ path, type: kind, data: Buffer.from(data) });
  }
  return out;
}

function header(path: string, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = path.lastIndexOf('/', path.length - 1);
    // Split at a slash so the name part fits in 100 bytes and the prefix in 155.
    let i = cut;
    while (i > 0 && (Buffer.byteLength(path.slice(i + 1)) > 100 || Buffer.byteLength(path.slice(0, i)) > 155)) i = path.lastIndexOf('/', i - 1);
    if (i <= 0) throw new Error(`path too long for a tar archive: ${path.slice(0, 80)}…`);
    prefix = path.slice(0, i);
    name = path.slice(i + 1);
  }
  h.write(name, 0, 100, 'utf8');
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

export function writeTar(entries: { path: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e.path, e.data.length, '0'), e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
