/** Pure helpers for the agent module (no I/O; unit-tested). */
import type { ModelMessage } from 'ai';

// ---------- Reply delivery ----------

export type DeliveryMode = 'stream' | 'post';

/**
 * Stream-or-post is decided in code, never by the model:
 * - synthesis turn → stream the synthesis below the (now finished) card;
 * - subagents running in the thread → post the reply whole (steers fold into the card);
 * - otherwise → stream.
 */
export function chooseDelivery(opts: { turnKind: 'user' | 'synthesis'; runningRuns: number }): DeliveryMode {
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
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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
  return s.length > COMPACT_KEEP_CHARS ? `${s.slice(0, COMPACT_KEEP_CHARS)}… [compacted]` : s;
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

/** Human-readable current step for the card, from a child's tool call. */
export function describeToolStep(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const q = (k: string) => (typeof i[k] === 'string' ? oneLine(i[k] as string, 60) : '');
  switch (toolName) {
    case 'web_search':
    case 'openrouter:web_search':
      return q('query') ? `Searching the web for “${q('query')}”` : 'Searching the web';
    case 'slack_search':
      return q('query') ? `Searching Slack for “${q('query')}”` : 'Searching Slack';
    case 'fetch_url':
      return q('url') ? `Reading ${q('url')}` : 'Reading a page';
    case 'read_thread':
      return 'Reading the thread';
    case 'read_channel':
      return 'Reading the channel';
    case 'read_image':
      return q('id') ? `Looking at ${q('id')}` : 'Looking at an image';
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
      return first ? `${toolName}: ${oneLine(first, 50)}` : `Using ${toolName}`;
    }
  }
}
