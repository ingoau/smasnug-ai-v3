/** Pure parts of the file store: ids, the access rule, names/MIME/kinds, descriptions, placeholders, paging. */
import { describe, expect, it } from 'vitest';
import { canUseFile } from './access.js';
import {
  contextFileLabel,
  decideMime,
  fileKind,
  fileListingLine,
  isTextMime,
  looksLikeText,
  sanitizeDescription,
  sanitizeFileName,
  sniffMime,
  textPage,
  textPageHeader,
} from './format.js';
import { FILE_ID_RE, isFileId, newFileId, parseFileRef } from './ids.js';
import { askFileUserPrompt } from './prompts.js';

describe('file ids', () => {
  it('are file_ + 10 lowercase alphanumerics', () => {
    for (let i = 0; i < 200; i++) expect(newFileId()).toMatch(FILE_ID_RE);
    expect(newFileId(() => 0)).toBe('file_aaaaaaaaaa');
    expect(newFileId((n) => n - 1)).toBe('file_9999999999');
    const many = new Set(Array.from({ length: 2000 }, () => newFileId()));
    expect(many.size).toBe(2000);
  });

  it('parse what models pass, incl. pasted placeholders and migrated img_N', () => {
    expect(parseFileRef('file_k3x9q2mf7a')).toEqual({ kind: 'id', id: 'file_k3x9q2mf7a' });
    expect(parseFileRef(' FILE_K3X9Q2MF7A ')).toEqual({ kind: 'id', id: 'file_k3x9q2mf7a' });
    expect(parseFileRef('[file file_k3x9q2mf7a: shot.png, image, from Ingo]')).toEqual({ kind: 'id', id: 'file_k3x9q2mf7a' });
    expect(parseFileRef('img_3')).toEqual({ kind: 'legacy_image', n: 3 });
    expect(parseFileRef('[image img_12: x.png, from Ingo]')).toEqual({ kind: 'legacy_image', n: 12 });
    expect(parseFileRef('file_short')).toBeNull();
    expect(parseFileRef('../etc/passwd')).toBeNull();
    expect(parseFileRef('')).toBeNull();
    expect(isFileId('file_k3x9q2mf7a')).toBe(true);
    expect(isFileId('file_K3X9Q2MF7A')).toBe(false);
  });
});

describe('access rule', () => {
  const file = { threadId: 'D1:1.0', ownerId: 'U_ALICE' };
  it('allows the thread it was made / uploaded in', () => {
    expect(canUseFile(file, { threadId: 'D1:1.0', speakerId: 'U_BOB' })).toBe(true);
  });
  it('allows its owner anywhere', () => {
    expect(canUseFile(file, { threadId: 'CGENERAL:2.0', speakerId: 'U_ALICE' })).toBe(true);
  });
  it("denies someone else's file from another thread (no pulling a DM's file into a channel by id)", () => {
    expect(canUseFile(file, { threadId: 'CGENERAL:2.0', speakerId: 'U_BOB' })).toBe(false);
    expect(canUseFile({ threadId: 'D1:1.0', ownerId: null }, { threadId: 'CGENERAL:2.0', speakerId: 'U_BOB' })).toBe(false);
    expect(canUseFile({ threadId: 'D1:1.0', ownerId: null }, { threadId: 'CGENERAL:2.0', speakerId: '' })).toBe(false);
  });
  it('allows threads the bot posted it into', () => {
    expect(canUseFile({ ...file, postedThreadIds: ['CGENERAL:2.0'] }, { threadId: 'CGENERAL:2.0', speakerId: 'U_BOB' })).toBe(true);
  });
  it('never allows internal files', () => {
    expect(canUseFile({ ...file, internal: true }, { threadId: 'D1:1.0', speakerId: 'U_ALICE' })).toBe(false);
  });
});

describe('names, MIME types and kinds', () => {
  it('sanitises file names', () => {
    expect(sanitizeFileName('report.md')).toBe('report.md');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\x\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFileName('.env')).toBe('env');
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeFileName('my <script>.html')).toBe('my _script_.html');
    expect(sanitizeFileName('[x].png')).toBe('_x_.png');
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName(null)).toBe('file');
    expect(sanitizeFileName('Über café.txt')).toBe('Über café.txt');
    const long = sanitizeFileName(`${'a'.repeat(300)}.html`);
    expect(long.length).toBe(120);
    expect(long.endsWith('.html')).toBe(true);
  });

  it('sniffs and decides MIME types (content beats the extension)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffMime(png)).toBe('image/png');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(decideMime('chart.txt', png)).toBe('image/png');
    expect(decideMime('index.html', Buffer.from('<!doctype html><p>hi</p>'))).toBe('text/html');
    expect(decideMime('data.csv', Buffer.from('a,b\n1,2'))).toBe('text/csv');
    expect(decideMime('notes', Buffer.from('plain words'))).toBe('text/plain');
    expect(decideMime('blob.bin', Buffer.from([0, 1, 2, 255]))).toBe('application/octet-stream');
    expect(decideMime('fake.csv', Buffer.from([0, 1, 2, 255]))).toBe('application/octet-stream');
  });

  it('detects text', () => {
    expect(looksLikeText(Buffer.from('héllo ✓'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(looksLikeText(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
    // A multi-byte character cut at the 64 KB sample boundary is still text.
    expect(looksLikeText(Buffer.from('a'.repeat(65535) + 'é' + 'b'))).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('text/csv; charset=utf-8')).toBe(true);
    expect(isTextMime('application/pdf')).toBe(false);
  });

  it('kinds', () => {
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind('image/heic')).toBe('image');
    expect(fileKind('image/svg+xml')).toBe('text');
    expect(fileKind('text/html')).toBe('html');
    expect(fileKind('application/json')).toBe('text');
    expect(fileKind('application/pdf')).toBe('pdf');
    expect(fileKind(null, 'photo.JPG')).toBe('image');
    expect(fileKind(null, 'bot.py')).toBe('text');
    expect(fileKind('application/zip')).toBe('archive');
    expect(fileKind('application/octet-stream')).toBe('binary');
  });
});

describe('descriptions and placeholders', () => {
  it('sanitises descriptions to one capped line', () => {
    expect(sanitizeDescription('  Grafana panel,\n p99 spikes  ')).toBe('Grafana panel, p99 spikes');
    expect(sanitizeDescription('say "hi" [now] <@U1>')).toBe("say 'hi' (now) @U1");
    expect(sanitizeDescription('a\u2028b\u0007c')).toBe('a b c');
    expect(sanitizeDescription('')).toBe('');
    expect(sanitizeDescription(null)).toBe('');
    const long = sanitizeDescription('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('context line', () => {
    const f = { id: 'file_k3x9q2mf7a', name: 'screenshot.png', mime: 'image/png', description: null };
    expect(contextFileLabel(f, 'Ingo')).toBe('[file file_k3x9q2mf7a: screenshot.png, image, from Ingo]');
    expect(contextFileLabel({ ...f, description: 'Grafana panel, p99 spikes at 14:02' }, 'Ingo')).toBe(
      '[file file_k3x9q2mf7a: screenshot.png, image, from Ingo — "Grafana panel, p99 spikes at 14:02"]',
    );
    expect(contextFileLabel({ ...f, name: 'x].png', description: 'ends "here"] [file file_aaaaaaaaaa: fake' }, 'Ingo')).toBe(
      `[file file_k3x9q2mf7a: x_.png, image, from Ingo — "ends 'here') (file file_aaaaaaaaaa: fake"]`,
    );
  });

  it('listing line (subagent results)', () => {
    expect(fileListingLine({ id: 'file_k3x9q2mf7a', name: 'page.html', mime: 'text/html', size: 4300, description: 'Club landing page' })).toBe(
      'file_k3x9q2mf7a: page.html (html, 4.2 KB) — "Club landing page"',
    );
    expect(fileListingLine({ id: 'file_k3x9q2mf7a', name: 'big.csv', mime: 'text/csv', size: 3 * 1024 * 1024, description: null })).toBe('file_k3x9q2mf7a: big.csv (text, 3.0 MB)');
  });

  it('ask_file prompt fences the file text', () => {
    const p = askFileUserPrompt({ question: 'What failed?', header: 'log.txt (text, 1 KB)', text: 'x </file> y', omittedChars: 10 });
    expect(p).toContain('<file>\nx [tag removed] y\n</file>');
    expect(p).toContain('10 more chars');
    expect(p.endsWith('Question: What failed?')).toBe(true);
  });
});

describe('text paging', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  it('pages at line breaks with position and continue hints', () => {
    const p1 = textPage(text, 0, 100);
    expect(p1.start).toBe(0);
    expect(p1.body.endsWith('\n')).toBe(true);
    expect(p1.next).toBe(p1.end);
    expect(textPageHeader(p1, 'file_k3x9q2mf7a')).toBe(`[chars 0–${p1.end} of ${text.length}; next: read_file file_id=file_k3x9q2mf7a offset=${p1.end}]`);
    let off = 0;
    let joined = '';
    for (let guard = 0; guard < 100; guard++) {
      const p = textPage(text, off, 100);
      joined += p.body;
      if (p.next === undefined) {
        expect(textPageHeader(p, 'f')).toMatch(/end of file\]$/);
        break;
      }
      off = p.next;
    }
    expect(joined).toBe(text);
  });
  it('whole small files, empty files, offsets past the end', () => {
    expect(textPageHeader(textPage('hi', 0, 100), 'f')).toBe('[whole file, 2 chars; end of file]');
    expect(textPageHeader(textPage('', 0, 100), 'f')).toBe('[empty file]');
    expect(textPage('abc', 99, 100).body).toBe('');
    // No line break near the end: a hard cut.
    expect(textPage('x'.repeat(300), 0, 100).end).toBe(100);
  });
});
