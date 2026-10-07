/**
 * Model markdown → Slack blocks, delivered exactly as written. Pure, no I/O.
 *
 * Why: Slack's `markdown` block / `markdown_text` stream converter rewrites some HTML tags into markdown everywhere,
 * including inside ``` code blocks and inline `code` (verified against real Slack): `<h1>…</h1>`…`<h6>` become
 * headings (closing tag dropped), `<code>x</code>` becomes `x` in backticks, `<img src="y">` becomes `![image](y)`.
 * Other tags (`<b>`, `<br>`, `<a href>`, `<div>`, `&` …) are left alone. HTML entities (`&lt;h1&gt;`) render as a
 * literal `<h1>` in prose, but stay literally `&lt;h1&gt;` inside code, so escaping code is not a fix.
 *
 * So:
 * - fenced code blocks (``` or ~~~, any indent, with or without a language) become `rich_text` blocks with a
 *   `rich_text_preformatted` element carrying the raw code. `language` is ALWAYS set (the fence's info word, else
 *   "text"): with a language Slack renders the same rich code component (header, copy button, highlighting) as a
 *   markdown fence; without one it falls back to a plain grey box (verified in Block Kit Builder);
 * - prose stays `markdown` (tables, bold, links, lists keep working), with only the affected tags' `<` written as
 *   `&lt;` (renders as a literal `<` in prose);
 * - a prose paragraph whose inline code span contains an affected tag can't be fixed in markdown (entities inside
 *   code stay literal), so that paragraph is rendered as `rich_text` instead (code-styled text elements are literal).
 *
 * Limits (docs.slack.dev): 50 blocks per message; all `markdown` blocks of one payload share 12,000 chars. Markdown
 * beyond the budget is rendered as rich_text; past the block limit the remaining segments merge into one rich_text
 * block. Streaming (`streamUnits`) uses the same pieces, cut so that what was already sent never changes.
 */

// ---------- Types (shapes mirror @slack/types) ----------

export type RichStyle = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
export type RichInline =
  | { type: 'text'; text: string; style?: RichStyle }
  | { type: 'link'; url: string; text?: string; style?: RichStyle }
  | { type: 'user'; user_id: string }
  | { type: 'channel'; channel_id: string };
export interface RichSection {
  type: 'rich_text_section';
  elements: RichInline[];
}
export interface RichList {
  type: 'rich_text_list';
  style: 'bullet' | 'ordered';
  indent?: number;
  offset?: number;
  elements: RichSection[];
}
export interface RichQuote {
  type: 'rich_text_quote';
  elements: RichInline[];
}
export interface RichPreformatted {
  type: 'rich_text_preformatted';
  language: string;
  elements: { type: 'text'; text: string }[];
}
export type RichElement = RichSection | RichList | RichQuote | RichPreformatted;
export interface RichTextBlock {
  type: 'rich_text';
  block_id?: string;
  elements: RichElement[];
}
export interface MarkdownBlock {
  type: 'markdown';
  block_id?: string;
  text: string;
}
export type ReplyBlock = MarkdownBlock | RichTextBlock;

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; code: string; language: string }
  /** Prose rendered as rich_text (inline code with an affected tag, or markdown over the char budget). */
  | { kind: 'rich'; text: string };

export const MAX_MESSAGE_BLOCKS = 50;
/** Cumulative markdown chars per payload (Slack: 12,000; a little headroom). */
export const MARKDOWN_BUDGET = 11_500;
/** Overall cap on one message's content; beyond it the text is cut with a note. */
const MAX_TOTAL_CHARS = 30_000;
/** `text` fallback (notifications, clients without blocks). */
export const MAX_FALLBACK_TEXT = 3_000;
const DEFAULT_LANGUAGE = 'text';

// ---------- Affected HTML tags ----------

const AFFECTED_TAG = /<\/?(?:h[1-6]|code|img)(?![a-z0-9-])/i;
/** The `<` of an affected tag (with a markdown backslash escape in front, if any). */
const AFFECTED_LT = /\\?<(?=\/?(?:h[1-6]|code|img)(?![a-z0-9-]))/gi;

export const hasAffectedTag = (s: string) => AFFECTED_TAG.test(s);

/** Prose markdown: write the `<` of affected tags as `&lt;` (Slack shows it as a literal `<`). Nothing else changes. */
export function escapeAffectedTags(md: string): string {
  return md.replace(AFFECTED_LT, '&lt;');
}

/**
 * Single-star emphasis on one line, `*x*`: not `**`, not a `* ` bullet, not inside a word (`2*3*4`), not escaped.
 * The model is told to write **bold** and _italic_, so a lone `*x*` is Slack's bold habit (mrkdwn `*bold*`), but
 * Slack's markdown renders it as italic: it is sent as `**x**` (and rendered bold in rich_text too).
 */
const STAR_PAIR = /(?<![\p{L}\p{N}*\\])\*(?![\s*])([^\n]*?[^\s*\\])\*(?![\p{L}\p{N}*])/gu;
const STAR_OPENER = /(?<![\p{L}\p{N}*\\])\*(?![\s*])/gu;

/** `*x*` → `**x**` outside inline code spans, paragraph by paragraph. */
export function boldSingleStars(md: string): string {
  if (!md.includes('*')) return md;
  let out = '';
  let last = 0;
  for (const p of paragraphs(md)) {
    out += md.slice(last, p.start);
    const para = md.slice(p.start, p.end);
    let at = 0;
    for (const sp of codeSpans(para, true).spans) {
      out += para.slice(at, sp.start).replace(STAR_PAIR, '**$1**') + para.slice(sp.start, sp.end);
      at = sp.end;
    }
    out += para.slice(at).replace(STAR_PAIR, '**$1**');
    last = p.end;
  }
  return out + md.slice(last);
}

/**
 * Streaming: where to hold back an incomplete paragraph so the `*x*` rewrite stays prefix-stable. A trailing run of
 * `*` (it may still become `**`, an opener or a closer), or a single-star opener on the last line whose closer
 * hasn't arrived yet (outside code spans). Returns para.length when nothing needs holding.
 */
function starHold(para: string, spans: Span[]): number {
  const lineStart = para.lastIndexOf('\n') + 1;
  const trailing = /\*+$/.exec(para);
  let hold = trailing ? trailing.index : para.length;
  const inSpan = (i: number) => spans.some((sp) => i >= sp.start && i < sp.end);
  // Without the held trailing stars: a pair they would close isn't closed yet either.
  const line = para.slice(lineStart, hold);
  const matched: [number, number][] = [];
  for (const m of line.matchAll(STAR_PAIR)) if (!inSpan(lineStart + m.index!)) matched.push([m.index!, m.index! + m[0].length]);
  for (const m of line.matchAll(STAR_OPENER)) {
    const i = m.index!;
    if (inSpan(lineStart + i) || matched.some(([s, e]) => i >= s && i < e)) continue;
    hold = Math.min(hold, lineStart + i);
    break;
  }
  return hold;
}

/** The markdown sent for prose: `*x*` as bold, affected tags escaped. */
const proseMarkdown = (md: string) => escapeAffectedTags(boldSingleStars(md));

// ---------- Code fences ----------

interface Fence {
  char: string;
  len: number;
  indent: number;
  language: string;
}

function openFence(line: string): Fence | null {
  const m = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const run = m[2]!;
  const info = m[3]!;
  if (run[0] === '`' && info.includes('`')) return null; // inline code, not a fence
  return { char: run[0]!, len: run.length, indent: m[1]!.replace(/\t/g, '    ').length, language: info.trim().split(/\s+/)[0] || DEFAULT_LANGUAGE };
}

/** A partial last line that could still be (or already is) a fence opener. */
function mayBecomeFence(tail: string): boolean {
  return /^[ \t]*(?:`{0,2}|~{0,2})$/.test(tail) || openFence(tail) !== null;
}

function closesFence(line: string, f: Fence): boolean {
  const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === f.char && m[1]!.length >= f.len;
}

function dedent(line: string, n: number): string {
  let i = 0;
  while (i < n && line[i] === ' ') i++;
  return line.slice(i);
}

type Region =
  | { type: 'prose'; start: number; end: number; open: boolean }
  | { type: 'code'; start: number; end: number; code: string; language: string }
  | { type: 'pending'; start: number };

/**
 * Cut text into prose and fenced-code regions. `final = false` (streaming): only complete lines count, a fence
 * that isn't closed yet is `pending` (nothing after it), and a trailing partial line that may still turn into a
 * fence (blank so far, or starting with ` or ~) is left out. `final = true`: an unclosed fence runs to the end (CommonMark).
 */
function scan(text: string, final: boolean): Region[] {
  const regions: Region[] = [];
  let pos = 0;
  let proseStart = 0;
  let fence: Fence | null = null;
  let fenceStart = 0;
  let lines: string[] = [];
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1 && !final) break;
    const lineEnd = nl === -1 ? text.length : nl;
    const next = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, lineEnd).replace(/\r$/, '');
    if (!fence) {
      const f = openFence(line);
      if (f) {
        if (pos > proseStart) regions.push({ type: 'prose', start: proseStart, end: pos, open: false });
        fence = f;
        fenceStart = pos;
        lines = [];
      }
    } else if (closesFence(line, fence)) {
      regions.push({ type: 'code', start: fenceStart, end: next, code: lines.join('\n'), language: fence.language });
      fence = null;
      proseStart = next;
    } else {
      lines.push(dedent(line, fence.indent));
    }
    pos = next;
  }
  if (fence) {
    if (final) regions.push({ type: 'code', start: fenceStart, end: text.length, code: lines.join('\n'), language: fence.language });
    else regions.push({ type: 'pending', start: fenceStart });
    return regions;
  }
  let end = text.length;
  if (!final && mayBecomeFence(text.slice(pos))) end = pos;
  if (end > proseStart) regions.push({ type: 'prose', start: proseStart, end, open: !final });
  return regions;
}

// ---------- Inline code spans ----------

interface Span {
  start: number;
  end: number;
  content: string;
}

/**
 * CommonMark code spans: a run of n backticks up to the next run of exactly n. `complete = false`: the paragraph
 * may still grow, so an opening run without its closer (or a run touching the end) is unresolved → `pending`.
 */
function codeSpans(s: string, complete: boolean): { spans: Span[]; pending: number | null } {
  const spans: Span[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && s[i + 1] === '`') {
      i += 2;
      continue;
    }
    if (s[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (s[i + n] === '`') n++;
    if (!complete && i + n === s.length) return { spans, pending: i };
    let j = i + n;
    let found = -1;
    let unresolved = false;
    while (j < s.length) {
      if (s[j] !== '`') {
        j++;
        continue;
      }
      let m = 0;
      while (s[j + m] === '`') m++;
      if (!complete && j + m === s.length) {
        unresolved = true;
        break;
      }
      if (m === n) {
        found = j;
        break;
      }
      j += m;
    }
    if (found >= 0) {
      spans.push({ start: i, end: found + n, content: s.slice(i + n, found) });
      i = found + n;
      continue;
    }
    if (!complete || unresolved) return { spans, pending: i };
    i += n; // no closer: literal backticks
  }
  return { spans, pending: null };
}

/** Paragraph ranges (split on blank lines) within s. */
function paragraphs(s: string): { start: number; end: number; complete: boolean }[] {
  const out: { start: number; end: number; complete: boolean }[] = [];
  const sep = /\n(?:[ \t]*\n)+/g;
  let last = 0;
  for (const m of s.matchAll(sep)) {
    if (m.index! > last) out.push({ start: last, end: m.index!, complete: true });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ start: last, end: s.length, complete: false });
  return out;
}

const affectedSpan = (para: string, complete: boolean) => codeSpans(para, complete).spans.find((sp) => hasAffectedTag(sp.content));

// ---------- Splitting (posted messages) ----------

function proseSegments(prose: string): Segment[] {
  const out: Segment[] = [];
  let cur: { kind: 'markdown' | 'rich'; start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const text = prose.slice(cur.start, cur.end);
    if (text.trim()) out.push({ kind: cur.kind, text: cur.kind === 'markdown' ? trimBlankLines(text) : text });
    cur = null;
  };
  for (const p of paragraphs(prose)) {
    const kind = affectedSpan(prose.slice(p.start, p.end), true) ? 'rich' : 'markdown';
    if (cur && cur.kind === kind) cur.end = p.end;
    else {
      flush();
      cur = { kind, start: p.start, end: p.end };
    }
  }
  flush();
  return out;
}

const trimBlankLines = (s: string) => s.replace(/^(?:[ \t]*\n)+/, '').trimEnd();

/** Model markdown → ordered segments (prose / fenced code / rich paragraphs). */
export function splitMarkdown(text: string): Segment[] {
  const out: Segment[] = [];
  for (const r of scan(text, true)) {
    if (r.type === 'code') out.push({ kind: 'code', code: r.code, language: r.language });
    else if (r.type === 'prose') out.push(...proseSegments(text.slice(r.start, r.end)));
  }
  return out;
}

// ---------- Streaming ----------

export type StreamUnit = { kind: 'md'; start: number; end: number } | { kind: 'block'; start: number; end: number; seg: Segment };

/**
 * What of a (partial) reply can be streamed now, as ordered units over `text` offsets: markdown text (the last
 * unit may still grow) and finished blocks (closed code fences, rich paragraphs). Prefix-stable: as text grows,
 * earlier units never change and the last markdown unit only extends. Differs from splitMarkdown in one way: a
 * paragraph is cut where its first affected inline code span starts (the text before it may already be out).
 */
export function streamUnits(text: string, final: boolean): StreamUnit[] {
  const units: StreamUnit[] = [];
  const md = (start: number, end: number) => {
    if (end <= start) return;
    const last = units[units.length - 1];
    if (last?.kind === 'md' && last.end === start) last.end = end;
    else units.push({ kind: 'md', start, end });
  };
  for (const r of scan(text, final)) {
    if (r.type === 'pending') break;
    if (r.type === 'code') {
      units.push({ kind: 'block', start: r.start, end: r.end, seg: { kind: 'code', code: r.code, language: r.language } });
      continue;
    }
    const prose = text.slice(r.start, r.end);
    let from = 0; // relative start of markdown not yet assigned
    let stop = false;
    for (const p of paragraphs(prose)) {
      const complete = p.complete || !r.open;
      const para = prose.slice(p.start, p.end);
      const { spans, pending } = codeSpans(para, complete);
      const hit = spans.find((sp) => hasAffectedTag(sp.content));
      if (hit) {
        md(r.start + from, r.start + p.start + hit.start);
        if (!complete) {
          stop = true;
          break;
        }
        units.push({ kind: 'block', start: r.start + p.start + hit.start, end: r.start + p.end, seg: { kind: 'rich', text: para.slice(hit.start) } });
        from = p.end;
        continue;
      }
      if (pending !== null) {
        md(r.start + from, r.start + p.start + pending);
        stop = true;
        break;
      }
      if (!complete) {
        // Hold back a trailing `\` / `<…` that may still become (an escaped) affected tag.
        // Also hold a `*` that may still open or close a `*x*` (sent as `**x**`, boldSingleStars).
        const hold = /\\?(?:<\/?[a-z0-9-]*)?$/i.exec(para)!;
        md(r.start + from, r.start + p.start + Math.min(hold.index, starHold(para, spans)));
        stop = true;
        break;
      }
    }
    if (stop) break;
    md(r.start + from, r.end);
  }
  return units;
}

/** The markdown actually sent for a markdown unit's raw text. */
export function mdDisplay(raw: string): string {
  return proseMarkdown(raw).replace(/^(?:[ \t]*\n)+/, '');
}

/** Concatenated markdown text of stream call args (`markdown_text` or `markdown_text` chunks). For tests/logs. */
export function streamArgsText(args: { markdown_text?: string; chunks?: { type: string; text?: string }[] }): string {
  if (typeof args.markdown_text === 'string') return args.markdown_text;
  return (args.chunks ?? []).map((c) => (c.type === 'markdown_text' ? (c.text ?? '') : '')).join('');
}

// ---------- Rich text rendering ----------

function styled(style: RichStyle): { style?: RichStyle } {
  const s: RichStyle = {};
  for (const [k, v] of Object.entries(style)) if (v) s[k as keyof RichStyle] = true;
  return Object.keys(s).length ? { style: s } : {};
}

/** CommonMark code span content: line endings → spaces, one surrounding space stripped. */
function codeContent(c: string): string {
  const s = c.replace(/\r?\n/g, ' ');
  return /^ .*[^ ].* $/.test(s) ? s.slice(1, -1) : s;
}

const INLINE =
  /\\([\\`*_{}\[\]()#+\-.!~<>|])|\[([^\]\n]+)\]\(([^)\s]+)\)|<(https?:\/\/[^|>\s]+)(?:\|([^>]+))?>|<@([UW][A-Z0-9]+)(?:\|[^>]*)?>|<#(C[A-Z0-9]+)(?:\|[^>]*)?>|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?!\*)|(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_])/g;

function parseStyled(t: string, style: RichStyle, out: RichInline[]) {
  let last = 0;
  const text = (s: string, st: RichStyle = style) => {
    if (s) out.push({ type: 'text', text: s, ...styled(st) });
  };
  for (const m of t.matchAll(INLINE)) {
    text(t.slice(last, m.index));
    if (m[1] !== undefined) text(m[1]);
    else if (m[2] !== undefined) out.push({ type: 'link', url: m[3]!, text: m[2], ...styled(style) });
    else if (m[4] !== undefined) out.push({ type: 'link', url: m[4], ...(m[5] ? { text: m[5] } : {}), ...styled(style) });
    else if (m[6] !== undefined) out.push({ type: 'user', user_id: m[6] });
    else if (m[7] !== undefined) out.push({ type: 'channel', channel_id: m[7] });
    else if (m[8] !== undefined || m[9] !== undefined) parseStyled((m[8] ?? m[9])!, { ...style, bold: true }, out);
    else if (m[10] !== undefined) parseStyled(m[10], { ...style, strike: true }, out);
    // A single-star `*x*` is bold, as in the markdown blocks (boldSingleStars); `_x_` is italic.
    else if (m[11] !== undefined) parseStyled(m[11], { ...style, bold: true }, out);
    else if (m[12] !== undefined) parseStyled(m[12], { ...style, italic: true }, out);
    else out.push({ type: 'link', url: m[13]!, ...styled(style) });
    last = m.index! + m[0].length;
  }
  text(t.slice(last));
}

/** Inline markdown → rich text elements; code spans become literal code-styled text. */
export function parseInline(s: string, style: RichStyle = {}): RichInline[] {
  const out: RichInline[] = [];
  let last = 0;
  for (const sp of codeSpans(s, true).spans) {
    parseStyled(s.slice(last, sp.start), style, out);
    out.push({ type: 'text', text: codeContent(sp.content), ...styled({ ...style, code: true }) });
    last = sp.end;
  }
  parseStyled(s.slice(last), style, out);
  return out;
}

/**
 * Markdown prose → rich_text elements: paragraphs and headings (bold) in sections with line breaks, bullet /
 * numbered lists (nesting by indent), quotes. Everything else (tables, rules) stays as its literal text.
 */
export function proseToRich(md: string): RichElement[] {
  const out: RichElement[] = [];
  let section: RichInline[] | null = null;
  let blank = false;
  let quote: string[] | null = null;
  const flushQuote = () => {
    if (quote) out.push({ type: 'rich_text_quote', elements: nonEmpty(parseInline(quote.join('\n'))) });
    quote = null;
  };
  const addLine = (els: RichInline[]) => {
    flushQuote();
    if (!section) {
      section = [];
      out.push({ type: 'rich_text_section', elements: section });
    } else section.push({ type: 'text', text: blank ? '\n\n' : '\n' });
    section.push(...els);
    blank = false;
  };
  for (const line of md.split('\n')) {
    if (!line.trim()) {
      blank = section !== null;
      continue;
    }
    const item = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushQuote();
      section = null;
      blank = false;
      const style = item[3] !== undefined ? 'ordered' : 'bullet';
      const indent = Math.min(8, Math.floor(item[1]!.replace(/\t/g, '    ').length / 2));
      const sec: RichSection = { type: 'rich_text_section', elements: nonEmpty(parseInline(item[4]!)) };
      const prev = out[out.length - 1];
      if (prev?.type === 'rich_text_list' && prev.style === style && (prev.indent ?? 0) === indent) prev.elements.push(sec);
      else {
        const start = item[3] !== undefined ? Number(item[3]) : 1;
        out.push({ type: 'rich_text_list', style, ...(indent ? { indent } : {}), ...(start > 1 ? { offset: start - 1 } : {}), elements: [sec] });
      }
      continue;
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      section = null;
      blank = false;
      (quote ??= []).push(q[1]!);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.type === 'rich_text_list' && /^\s+\S/.test(line) && !blank) {
      // Continuation of the last list item.
      const lastItem = prev.elements[prev.elements.length - 1]!;
      lastItem.elements.push({ type: 'text', text: '\n' }, ...parseInline(line.trim()));
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    addLine(h ? parseInline(h[1]!, { bold: true }) : parseInline(line));
  }
  flushQuote();
  return out;
}

function nonEmpty(els: RichInline[]): RichInline[] {
  return els.length ? els : [{ type: 'text', text: ' ' }];
}

export function codeElement(code: string, language: string): RichPreformatted {
  return { type: 'rich_text_preformatted', language: language || DEFAULT_LANGUAGE, elements: [{ type: 'text', text: code.length ? code : ' ' }] };
}

function richElements(seg: Segment): RichElement[] {
  if (seg.kind === 'code') return [codeElement(seg.code, seg.language)];
  return proseToRich(seg.text);
}

export function segmentBlock(seg: Segment): ReplyBlock {
  if (seg.kind === 'markdown') return { type: 'markdown', text: proseMarkdown(seg.text) };
  return { type: 'rich_text', elements: nonEmptyElements(richElements(seg)) };
}

function nonEmptyElements(els: RichElement[]): RichElement[] {
  return els.length ? els : [{ type: 'rich_text_section', elements: [{ type: 'text', text: ' ' }] }];
}

// ---------- Messages ----------

/**
 * The blocks for a reply's text, within Slack's limits: `maxBlocks` (leave room for e.g. buttons or a plan),
 * the shared markdown budget (overflowing prose → rich_text), and an overall size cap (cut with a note).
 */
export function replyBlocks(text: string, opts: { maxBlocks?: number } = {}): ReplyBlock[] {
  const maxBlocks = Math.max(1, opts.maxBlocks ?? MAX_MESSAGE_BLOCKS);
  const src = text.length > MAX_TOTAL_CHARS ? text.slice(0, MAX_TOTAL_CHARS) : text;
  let segs = splitMarkdown(src);
  if (src.length < text.length) segs.push({ kind: 'markdown', text: '_[message truncated]_' });
  if (!segs.length) return [{ type: 'markdown', text: src }];
  let budget = MARKDOWN_BUDGET;
  segs = segs.map((s) => {
    if (s.kind !== 'markdown') return s;
    const len = proseMarkdown(s.text).length;
    if (len > budget) return { kind: 'rich', text: s.text };
    budget -= len;
    return s;
  });
  if (segs.length <= maxBlocks) return segs.map(segmentBlock);
  const head = segs.slice(0, maxBlocks - 1).map(segmentBlock);
  return [...head, { type: 'rich_text', elements: nonEmptyElements(segs.slice(maxBlocks - 1).flatMap(richElements)) }];
}

/** A reply as a chat.postMessage / chat.update payload: blocks + the raw text as the `text` fallback. */
export function replyMessage(text: string, opts: { maxBlocks?: number } = {}): { text: string; blocks: ReplyBlock[] } {
  return { text: text.slice(0, MAX_FALLBACK_TEXT), blocks: replyBlocks(text, opts) };
}

/** Readable text of reply blocks as they come back from Slack (markdown + rich_text), e.g. for report snapshots. */
export function blocksText(blocks: readonly any[]): string | undefined {
  const inline = (els: any[] = []) =>
    els
      .map((e) => (e?.type === 'text' ? (e.style?.code ? `\`${e.text}\`` : e.text) : e?.type === 'link' ? (e.text ?? e.url) : e?.type === 'user' ? `<@${e.user_id}>` : e?.type === 'channel' ? `<#${e.channel_id}>` : ''))
      .join('');
  const parts: string[] = [];
  for (const b of blocks) {
    if (b?.type === 'markdown' && typeof b.text === 'string') parts.push(b.text);
    else if (b?.type === 'rich_text') {
      for (const el of b.elements ?? []) {
        if (el?.type === 'rich_text_preformatted') parts.push(`\`\`\`${el.language ?? ''}\n${inline(el.elements)}\n\`\`\``);
        else if (el?.type === 'rich_text_list') parts.push((el.elements ?? []).map((s: any, i: number) => `${el.style === 'ordered' ? `${i + 1 + (el.offset ?? 0)}.` : '-'} ${inline(s.elements)}`).join('\n'));
        else if (el?.type === 'rich_text_quote') parts.push(`> ${inline(el.elements)}`);
        else parts.push(inline(el?.elements));
      }
    }
  }
  return parts.length ? parts.join('\n\n') : undefined;
}
