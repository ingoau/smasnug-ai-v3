/** Pure helpers for the agent module (no I/O; unit-tested). */
import type { ModelMessage } from 'ai';
import { sliceUnits } from '../tools/util.js';
import { activityForTool, DEFAULT_ACTIVITY } from './activity.js';

// ---------- Reply delivery ----------

export type DeliveryMode = 'stream' | 'post';

/**
 * Stream-or-post is decided in code, never by the model:
 * - synthesis turn → stream the synthesis below the (now finished) card;
 * - subagents running in the thread → post the reply whole (steers fold into the card);
 * - otherwise → stream.
 */
export function chooseDelivery(opts: { turnKind: 'user' | 'synthesis' | 'scheduled'; runningRuns: number }): DeliveryMode {
  if (opts.turnKind === 'synthesis') return 'stream';
  return opts.runningRuns > 0 ? 'post' : 'stream';
}

// ---------- Token budgets ----------

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Clip a prompt section to a token budget. `keep: 'tail'` keeps the end (e.g. thread history, where recent
 * messages matter most), `'head'` keeps the start.
 */
export function clipTokens(text: string, budget: number, keep: 'head' | 'tail' = 'head', note = 'section truncated'): string {
  const maxChars = budget * 4;
  if (text.length <= maxChars) return text;
  if (keep === 'tail') {
    let cut = text.slice(text.length - maxChars);
    const nl = cut.indexOf('\n');
    if (nl > 0 && nl < 400) cut = cut.slice(nl + 1);
    return `[… ${note}]\n${cut}`;
  }
  let cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  if (nl > maxChars - 400) cut = cut.slice(0, nl);
  return `${cut}\n[… ${note}]`;
}

export function oneLine(s: string, max = 100): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${sliceUnits(t, max - 1)}…` : t;
}

// ---------- Subagent results ----------

/**
 * Children end their final message with `SUMMARY: <one line>`. Returns the full result (without the summary line)
 * and the one-liner for the card; falls back to the first sentence when the line is missing.
 */
export function splitResult(text: string): { result: string; output: string } {
  const trimmed = text.trim();
  const m = trimmed.match(/(?:^|\n)\s*\**SUMMARY\**:\**\s*(.+?)\s*$/i);
  if (m && m.index !== undefined) {
    const result = trimmed.slice(0, m.index).trim();
    return { result: result || m[1]!.trim(), output: oneLine(m[1]!, 120) };
  }
  if (!trimmed) return { result: '', output: 'Finished (no result)' };
  const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed;
  const plain = firstLine
    .replace(/^\s*(#+|[-*•]|\d+[.)])\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
  const sentence = plain.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? plain;
  return { result: trimmed, output: oneLine(sentence, 120) };
}

/** Short steer note for the card row, derived from the steer text when the agent gives none. */
export function deriveSteerNote(text: string): string {
  return oneLine(text, 60);
}

// ---------- History compaction ----------

const COMPACT_KEEP_CHARS = 400;

function compactValue(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return '';
  return s.length > COMPACT_KEEP_CHARS ? `${sliceUnits(s, COMPACT_KEEP_CHARS)}… [compacted]` : s;
}

/**
 * Compact a subagent's persisted history at run end: tool results are cut to short summaries, images/files in
 * tool results and user messages are replaced by placeholders, and reasoning parts are dropped, so long-lived
 * subagents don't grow without bound. Assistant text (the results themselves) and the instructions are kept.
 */
export function compactHistory(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'tool') {
      return {
        ...m,
        content: m.content.map((p) => {
          if (p.type !== 'tool-result') return p;
          const out = p.output;
          let value: string;
          switch (out.type) {
            case 'text':
            case 'error-text':
              value = compactValue(out.value);
              break;
            case 'json':
            case 'error-json':
              value = compactValue(out.value);
              break;
            case 'content':
              value = compactValue(
                out.value.map((c) => (c.type === 'text' ? c.text : `[${c.type} omitted]`)).join('\n'),
              );
              break;
            default:
              return p;
          }
          return { ...p, output: { type: out.type.startsWith('error') ? 'error-text' : 'text', value } };
        }),
      };
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content
          .filter((p) => p.type !== 'reasoning' && p.type !== 'reasoning-file')
          .map((p) => (p.type === 'file' ? { type: 'text' as const, text: '[file omitted]' } : p)),
      };
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((p) => (p.type === 'text' ? p : { type: 'text' as const, text: `[${p.type} omitted]` })),
      };
    }
    return m;
  });
}

// ---------- Progress lines ----------

/** "docs.fly.io" for a page URL (the site, not the whole URL); the URL clipped if it doesn't parse. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || oneLine(url, 60);
  } catch {
    return oneLine(url, 60);
  }
}

/**
 * Human-readable current step for the card, from a child's tool call. Users see it (also as the plan title), so it
 * never shows tool names or file ids: `fileName` is the name of the file a read_file / ask_file call opens (resolved
 * by the caller under the file access rule), else the step says "a file".
 */
export function describeToolStep(toolName: string, input: unknown, opts: { fileName?: string } = {}): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const q = (k: string) => (typeof i[k] === 'string' ? oneLine(i[k] as string, 60) : '');
  const file = opts.fileName?.trim() ? oneLine(opts.fileName, 60) : '';
  switch (toolName) {
    case 'web_search':
      return q('query') ? `Searching the web for “${q('query')}”` : 'Searching the web';
    case 'slack_search':
      return q('query') ? `Searching Slack for “${q('query')}”` : 'Searching Slack';
    case 'wait_for_searches':
      return 'Waiting for queued Slack searches';
    case 'find_people':
      return q('query') ? `Looking up “${q('query')}” in the directory` : 'Looking people up';
    case 'find_channels':
      return q('query') ? `Looking for channels about “${q('query')}”` : 'Looking for channels';
    case 'fetch_url':
      return typeof i.url === 'string' && i.url.trim() ? `Reading ${siteOf(i.url.trim())}` : 'Reading a page';
    case 'read_thread':
      return 'Reading the thread';
    case 'ask_thread':
      return i.permalink ? 'Reading a Slack thread' : 'Reading the thread';
    case 'read_public_thread':
      return 'Reading a Slack thread';
    case 'read_public_channel':
      return 'Reading a Slack channel';
    case 'read_channel':
      return 'Reading the channel';
    case 'read_file':
      return file ? `Opening ${file}` : 'Opening a file';
    case 'ask_file':
      return file ? `Reading ${file}` : 'Reading a file';
    case 'read_canvas':
      return 'Reading a canvas';
    case 'create_file':
      return q('name') ? `Writing ${q('name')}` : 'Writing a file';
    case 'sandbox_exec':
      return q('command') ? `Running \`${oneLine(q('command'), 50)}\`` : 'Running code';
    case 'sandbox_read_file':
      return q('path') ? `Looking at ${q('path')}` : 'Looking at a file';
    case 'sandbox_write_file':
      return q('path') ? `Writing ${q('path')}` : 'Writing a file';
    case 'sandbox_import':
      return 'Copying a file into the sandbox';
    case 'sandbox_export':
      return q('name') || q('path') ? `Exporting ${(q('name') || q('path')).split('/').pop()}` : 'Exporting a file';
    case 'request_preview':
      return 'Preparing a live preview';
    default: {
      // The status-indicator label for the tool ("Reading the canvas…" → "Reading the canvas"), else "Working…".
      const label = activityForTool(toolName) ?? DEFAULT_ACTIVITY;
      return label === DEFAULT_ACTIVITY ? label : label.replace(/…$/, '');
    }
  }
}

/** Lowercased words only: markdown, links, mentions and punctuation stripped. */
export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(s: string): string {
  const first = s.split(/[.!?…\n]/).find((p) => p.trim()) ?? '';
  return normalizeForCompare(first);
}

/**
 * True when two replies say essentially the same thing: identical after normalising, one contained in the other,
 * the same first sentence, or ≥ 70% word overlap. Deliberately simple; used to drop repeated replies in a turn.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= 20 && long.includes(short)) return true;
  const fa = firstSentence(a);
  if (fa.length >= 20 && fa === firstSentence(b)) return true;
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  if (wa.size < 4 || wb.size < 4) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter) >= 0.7;
}

/** Sources stored per run (the card shows fewer). */
const MAX_SOURCES = 10;

export interface RunSource {
  url: string;
  title?: string;
}

/** Add a source if it's an http(s) URL not seen yet (ignoring the fragment and a trailing slash). Returns true if added. */
export function addSource(list: RunSource[], url: unknown, title?: unknown): boolean {
  if (typeof url !== 'string' || list.length >= MAX_SOURCES) return false;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  u.hash = '';
  // Tracking parameters (search engines append utm_source=openai etc.).
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|trk$|ref_src$)/.test(k)) u.searchParams.delete(k);
  u.pathname = u.pathname.replace(/[.,;:]+$/, ''); // citation URLs sometimes carry the sentence's punctuation
  const key = u.toString().replace(/\/$/, '');
  if (list.some((s) => s.url.replace(/\/$/, '') === key)) return false;
  list.push({ url: u.toString().slice(0, 2000), ...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 200) } : {}) });
  return true;
}

/** URLs written in a result text (markdown links and bare URLs), in order. */
export function urlsInText(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>()\[\]"'`]+[^\s<>()\[\]"'`.,;:!?*_]/g)].map((m) => m[0]);
}
