/**
 * Markdown (as subagents write it) → Slack rich_text elements, for task_card output. Pure. Keeps paragraphs,
 * headings (bold), bullet / numbered lists, **bold**, `code` and links readable; tables become "a · b · c" lines;
 * code fences are dropped (their content kept). Truncates to a char / line budget with "…".
 */
export type RichTextStyle = { bold?: boolean; italic?: boolean; code?: boolean };
export type RichTextInline = { type: 'text'; text: string; style?: RichTextStyle } | { type: 'link'; url: string; text?: string; style?: RichTextStyle };
export interface RichTextSection {
  type: 'rich_text_section';
  elements: RichTextInline[];
}
export interface RichTextList {
  type: 'rich_text_list';
  style: 'bullet' | 'ordered';
  elements: RichTextSection[];
}
export type RichTextElement = RichTextSection | RichTextList;

/** Inline markdown → rich text elements. */
export function inlineToRich(text: string, base: RichTextStyle = {}): RichTextInline[] {
  const out: RichTextInline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  const style = (extra: RichTextStyle = {}) => {
    const st = { ...base, ...extra };
    return Object.keys(st).length ? { style: st } : {};
  };
  const pushText = (t: string, extra?: RichTextStyle) => {
    if (t) out.push({ type: 'text', text: t, ...style(extra) });
  };
  for (const m of text.matchAll(re)) {
    pushText(text.slice(last, m.index));
    if (m[1] !== undefined) pushText(m[1], { bold: true });
    else if (m[2] !== undefined) pushText(m[2], { code: true });
    else if (m[3] !== undefined) out.push({ type: 'link', url: m[4]!, text: m[3], ...style() });
    else out.push({ type: 'link', url: m[5]!, ...style() });
    last = m.index! + m[0].length;
  }
  pushText(text.slice(last));
  return out;
}

const inlineLength = (els: RichTextInline[]) => els.reduce((n, e) => n + (e.type === 'text' ? e.text.length : (e.text ?? e.url).length), 0);

/** Cut inline elements to `max` visible chars, appending "…". */
function cutInline(els: RichTextInline[], max: number): RichTextInline[] {
  const out: RichTextInline[] = [];
  let left = max;
  for (const e of els) {
    const len = e.type === 'text' ? e.text.length : (e.text ?? e.url).length;
    if (len <= left) {
      out.push(e);
      left -= len;
      continue;
    }
    if (e.type === 'text' && left > 0) out.push({ ...e, text: e.text.slice(0, left).trimEnd() });
    break;
  }
  out.push({ type: 'text', text: '…' });
  return out;
}

interface Line {
  kind: 'para' | 'bullet' | 'ordered';
  els: RichTextInline[];
}

function parseLines(md: string): Line[] {
  const lines: Line[] = [];
  for (const raw of md.replace(/[^]*/g, '').replace(/[-]/g, '').split('\n')) {
    const l = raw.trimEnd();
    if (!l.trim() || /^\s*```/.test(l) || /^\s*\|?\s*:?-{3,}/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l)) continue;
    const heading = l.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      lines.push({ kind: 'para', els: inlineToRich(heading[1]!.replace(/\*\*/g, ''), { bold: true }) });
      continue;
    }
    const bullet = l.match(/^\s*[-*•+]\s+(.*)$/);
    if (bullet) {
      lines.push({ kind: 'bullet', els: inlineToRich(bullet[1]!) });
      continue;
    }
    const ordered = l.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      lines.push({ kind: 'ordered', els: inlineToRich(ordered[1]!) });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const cells = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean);
      lines.push({ kind: 'para', els: inlineToRich(cells.join(' · ')) });
      continue;
    }
    lines.push({ kind: 'para', els: inlineToRich(l.trim().replace(/^>\s?/, '')) });
  }
  return lines;
}

/** Markdown → rich_text elements within `maxChars` visible chars and `maxLines` lines ("…" when cut). */
export function markdownToRich(md: string, opts: { maxChars: number; maxLines: number }): RichTextElement[] {
  const lines = parseLines(md);
  const kept: Line[] = [];
  let chars = 0;
  let cut = false;
  for (const line of lines) {
    if (kept.length >= opts.maxLines || chars >= opts.maxChars) {
      cut = true;
      break;
    }
    const len = inlineLength(line.els);
    if (chars + len > opts.maxChars) {
      kept.push({ ...line, els: cutInline(line.els, Math.max(0, opts.maxChars - chars)) });
      chars = opts.maxChars;
      cut = false; // already marked with "…"
      break;
    }
    kept.push(line);
    chars += len;
  }
  if (cut && kept.length) {
    const lastLine = kept[kept.length - 1]!;
    lastLine.els = [...lastLine.els, { type: 'text', text: ' …' }];
  }
  // Group consecutive list items into lists.
  const out: RichTextElement[] = [];
  for (const line of kept) {
    const section: RichTextSection = { type: 'rich_text_section', elements: line.els.length ? line.els : [{ type: 'text', text: ' ' }] };
    if (line.kind === 'para') {
      // Consecutive paragraph lines share one section, separated by line breaks.
      const prev = out[out.length - 1];
      if (prev?.type === 'rich_text_section') prev.elements.push({ type: 'text', text: '\n' }, ...section.elements);
      else out.push(section);
      continue;
    }
    const style = line.kind === 'bullet' ? 'bullet' : 'ordered';
    const prev = out[out.length - 1];
    if (prev?.type === 'rich_text_list' && prev.style === style) prev.elements.push(section);
    else out.push({ type: 'rich_text_list', style, elements: [section] });
  }
  return out;
}
