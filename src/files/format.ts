/**
 * Pure helpers of the file store: names, MIME types, kinds, descriptions, context placeholders and text paging.
 * No I/O; unit-tested in format.test.ts.
 */

/** Longest stored file name (the extension is kept when cutting). */
export const MAX_NAME_CHARS = 120;
/** Descriptions are one line of at most this many chars (they come from models, i.e. untrusted). */
export const MAX_DESCRIPTION_CHARS = 200;

/**
 * A safe file name: no directories, control characters or path tricks, a conservative character set, no leading
 * dots, at most MAX_NAME_CHARS (keeping the extension). Falls back to `file`.
 */
export function sanitizeFileName(raw: string | null | undefined, fallback = 'file'): string {
  let s = String(raw ?? '').normalize('NFC');
  s = s.split(/[\\/]/).pop() ?? '';
  s = s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[^\p{L}\p{N} ._\-()+,@#&=~]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!s || /^_+$/.test(s)) return fallback;
  if (s.length > MAX_NAME_CHARS) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, MAX_NAME_CHARS - ext.length).trimEnd() + ext;
  }
  return s;
}

const EXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  jsx: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  log: 'text/plain',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  ps1: 'text/plain',
  sql: 'application/sql',
  lua: 'text/x-lua',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export function extensionOf(name: string | null | undefined): string {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name ?? '');
  return m ? m[1]!.toLowerCase() : '';
}

/** MIME type from the file name's extension, or undefined. */
export function mimeFromName(name: string | null | undefined): string | undefined {
  return EXT_MIME[extensionOf(name)];
}

/** MIME type from magic bytes (common binaries only), or undefined. */
export function sniffMime(b: Buffer): string | undefined {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'avif') return 'image/avif';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  return undefined;
}

/** True for UTF-8 text without NUL bytes (checks the first 64 KB). */
export function looksLikeText(b: Buffer): boolean {
  const head = b.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    // A multi-byte character cut at the 64 KB boundary is fine: only check up to the last complete one.
    new TextDecoder('utf-8', { fatal: true }).decode(head.length === b.length ? head : trimPartialUtf8(head));
    return true;
  } catch {
    return false;
  }
}

function trimPartialUtf8(b: Buffer): Buffer {
  let end = b.length;
  // Step back over continuation bytes (10xxxxxx) to the start of the last character, then drop it.
  let i = end - 1;
  while (i >= 0 && i > end - 4 && (b[i]! & 0xc0) === 0x80) i--;
  if (i >= 0 && b[i]! >= 0xc0) end = i;
  return b.subarray(0, end);
}

const TEXTUAL_APP = /^application\/(json|xml|yaml|toml|sql|javascript|x-ndjson|ld\+json|x-sh|x-yaml)$/;

/** Text we can page through (text/*, JSON, XML, SVG source, code). */
export function isTextMime(mime: string | null | undefined): boolean {
  const m = (mime ?? '').toLowerCase().split(';')[0]!.trim();
  return m.startsWith('text/') || TEXTUAL_APP.test(m) || m === 'image/svg+xml' || /\+(json|xml)$/.test(m);
}

/** Raster images the model can look at (SVG is text, not an image here). */
export function isImageMime(mime: string | null | undefined, name?: string | null): boolean {
  const m = (mime ?? '').toLowerCase();
  if (m === 'image/svg+xml') return false;
  if (m.startsWith('image/')) return true;
  return !m && /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i.test(name ?? '');
}

/** The MIME type a new file gets: sniffed content beats the extension; text falls back to text/plain. */
export function decideMime(name: string, bytes: Buffer): string {
  const sniffed = sniffMime(bytes);
  if (sniffed) return sniffed;
  const byName = mimeFromName(name);
  if (byName && (isTextMime(byName) ? looksLikeText(bytes) : true)) return byName;
  return looksLikeText(bytes) ? 'text/plain' : 'application/octet-stream';
}

export type FileKind = 'image' | 'html' | 'text' | 'pdf' | 'audio' | 'video' | 'archive' | 'binary';

/** Short kind shown in context lines and listings. */
export function fileKind(mime: string | null | undefined, name?: string | null): FileKind {
  const m = (mime ?? mimeFromName(name) ?? '').toLowerCase();
  if (isImageMime(m, name)) return 'image';
  if (m === 'text/html') return 'html';
  if (isTextMime(m)) return 'text';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (/zip|gzip|x-tar|x-7z|x-rar|compressed/.test(m)) return 'archive';
  return 'binary';
}

/**
 * One line, at most `max` chars, no control characters; quotes and brackets that would break the context
 * placeholder are softened. Returns '' for nothing usable.
 */
export function sanitizeDescription(raw: string | null | undefined, max = MAX_DESCRIPTION_CHARS): string {
  let s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/["“”]/g, "'")
    .replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'))
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    let cut = s.slice(0, max - 1);
    const ws = cut.lastIndexOf(' ');
    if (ws > max * 0.7) cut = cut.slice(0, ws);
    s = `${cut.trimEnd()}…`;
  }
  return s;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'size unknown';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface ContextFile {
  id: string;
  name: string;
  mime: string | null;
  description: string | null;
}

/** `[file file_k3x9q2mf7a: screenshot.png, image, from Ingo — "Grafana panel, p99 spikes at 14:02"]` */
export function contextFileLabel(f: ContextFile, from: string): string {
  const desc = f.description ? sanitizeDescription(f.description) : '';
  return `[file ${f.id}: ${sanitizeFileName(f.name)}, ${fileKind(f.mime, f.name)}, from ${from}${desc ? ` — "${desc}"` : ''}]`;
}

export interface FileListing {
  id: string;
  name: string;
  mime: string | null;
  size: number | null;
  description: string | null;
}

/** `file_k3x9q2mf7a: page.html (html, 4.2 KB) — "Landing page for the robotics club"` (results, tool outputs). */
export function fileListingLine(f: FileListing): string {
  const desc = f.description ? sanitizeDescription(f.description) : '';
  return `${f.id}: ${sanitizeFileName(f.name)} (${fileKind(f.mime, f.name)}, ${formatBytes(f.size)})${desc ? ` — "${desc}"` : ''}`;
}

export interface TextPage {
  body: string;
  /** Char offsets of this page: [start, end). */
  start: number;
  end: number;
  total: number;
  /** Offset of the next page, if there is more. */
  next?: number;
}

/** A page of text from `offset`, at most `maxChars`, cut at a line break where one is near the end. */
export function textPage(text: string, offset: number, maxChars: number): TextPage {
  const total = text.length;
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, total));
  if (total - start <= maxChars) return { body: text.slice(start), start, end: total, total };
  let end = start + maxChars;
  const nl = text.lastIndexOf('\n', end);
  if (nl > start + maxChars * 0.8) end = nl + 1;
  return { body: text.slice(start, end), start, end, total, next: end };
}

/** `[chars 0–24000 of 81234; next: read_file file_id=file_x offset=24000]` */
export function textPageHeader(p: TextPage, fileId: string): string {
  if (p.total === 0) return '[empty file]';
  const pos = p.start === 0 && p.end === p.total ? `whole file, ${p.total} chars` : `chars ${p.start}–${p.end} of ${p.total}`;
  const nav = p.next !== undefined ? `next: read_file file_id=${fileId} offset=${p.next}` : 'end of file';
  return `[${pos}; ${nav}]`;
}
