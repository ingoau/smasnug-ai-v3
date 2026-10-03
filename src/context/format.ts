/**
 * Pure formatting of Slack messages for model context. No I/O — callers resolve names / image ids first.
 *
 * Line format (one message; text may span lines):
 *   [1727950000.123456] <@U123> Ingo: hello <@U456|Bob> [file: budget.csv] [image img_3: screenshot.png, from Ingo]
 *   [1727950001.000200] [bot] Gorkie: …
 *   [1727950002.000300] [bot] Smasnug (you): …
 * The bracketed number is the message ts (used by react / read_thread before_ts / read_channel before_ts).
 */
import type { SlackFileRef } from '../core/types.js';

export interface RenderMsg {
  ts: string;
  userId: string | null;
  botId: string | null;
  username: string | null;
  text: string;
  files: SlackFileRef[];
  edited?: boolean;
  deleted?: boolean;
  /** Channel messages only: number of thread replies. */
  replyCount?: number;
}

export interface FormatEnv {
  /** userId → display name (authors, mentions). Missing ids render without a name. */
  names: Map<string, string>;
  /** Slack file id → thread image number (img_N). */
  imageIds: Map<string, number>;
  /** The bot itself, so its own messages are labelled "(you)". */
  self?: { userId?: string; botId?: string; name: string };
  /** Message text longer than this is cut with " [truncated]". */
  maxChars: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i;

/** Raster images we can read (SVG deliberately excluded — treated as a plain file). */
export function isImageFile(f: SlackFileRef): boolean {
  const mt = (f.mimetype ?? '').toLowerCase();
  if (mt === 'image/svg+xml') return false;
  if (mt.startsWith('image/')) return true;
  return !mt && IMAGE_EXT.test(f.name ?? '');
}

export function compareTs(a: string, b: string): number {
  const [as, au = ''] = a.split('.');
  const [bs, bu = ''] = b.split('.');
  return Number(as) - Number(bs) || Number(au.padEnd(6, '0')) - Number(bu.padEnd(6, '0'));
}

export function isBotMessage(m: RenderMsg): boolean {
  return !!m.botId;
}

export function authorLabel(m: RenderMsg, env: FormatEnv): string {
  const self = env.self;
  if (self && ((m.botId && m.botId === self.botId) || (m.userId && m.userId === self.userId))) return `[bot] ${self.name} (you)`;
  if (isBotMessage(m)) return `[bot] ${m.username || (m.userId && env.names.get(m.userId)) || 'bot'}`;
  if (!m.userId) return m.username || 'unknown';
  const name = env.names.get(m.userId);
  return name ? `<@${m.userId}> ${name}` : `<@${m.userId}>`;
}

export function authorName(m: RenderMsg, env: FormatEnv): string {
  if (isBotMessage(m)) return m.username || 'bot';
  return (m.userId && env.names.get(m.userId)) || m.username || m.userId || 'unknown';
}

/** Slack mrkdwn → plain-ish text: decode entities, name mentions, flatten links and special mentions. */
export function renderSlackText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => (names.get(id) ? `<@${id}|${names.get(id)}>` : `<@${id}>`))
    .replace(/<#(C[A-Z0-9]+)\|([^>]*)>/g, (_m, id: string, name: string) => (name ? `#${name}` : `<#${id}>`))
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label?: string) => label || '@group')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function truncateText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let cut = s.slice(0, maxChars);
  const ws = cut.search(/\s\S*$/);
  if (ws > maxChars * 0.8) cut = cut.slice(0, ws);
  return `${cut.trimEnd()} [truncated]`;
}

export function fileLabel(f: SlackFileRef, from: string, env: FormatEnv): string {
  const name = f.name || 'file';
  const n = env.imageIds.get(f.id);
  if (isImageFile(f) && n !== undefined) return `[image img_${n}: ${name}, from ${from}]`;
  return `[file: ${name}]`;
}

export function formatMessage(m: RenderMsg, env: FormatEnv): string {
  const text = truncateText(renderSlackText(m.text ?? '', env.names).trim(), env.maxChars);
  const from = authorName(m, env);
  const files = (m.files ?? []).map((f) => fileLabel(f, from, env));
  const parts = [text, ...files].filter(Boolean);
  if (m.edited) parts.push('(edited)');
  if (m.replyCount) parts.push(`[thread: ${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}]`);
  return `[${m.ts}] ${authorLabel(m, env)}: ${parts.join(' ')}`;
}

/** Messages in ts order, deleted ones dropped. */
export function formatMessages(msgs: RenderMsg[], env: FormatEnv): string {
  return msgs
    .filter((m) => !m.deleted)
    .sort((a, b) => compareTs(a.ts, b.ts))
    .map((m) => formatMessage(m, env))
    .join('\n');
}

export interface ThreadSelection {
  parent?: RenderMsg;
  replies: RenderMsg[];
  omitted: number;
}

/** Pick the parent + the last `maxReplies` replies (deleted dropped); count how many earlier replies were left out. */
export function selectThread(msgs: RenderMsg[], threadTs: string, maxReplies: number): ThreadSelection {
  const live = msgs.filter((m) => !m.deleted).sort((a, b) => compareTs(a.ts, b.ts));
  const parent = live.find((m) => m.ts === threadTs);
  const replies = live.filter((m) => m.ts !== threadTs);
  const kept = maxReplies > 0 ? replies.slice(-maxReplies) : [];
  return { parent, replies: kept, omitted: replies.length - kept.length };
}

export function formatThread(sel: ThreadSelection, env: FormatEnv): string {
  const lines: string[] = [];
  if (sel.parent) lines.push(formatMessage({ ...sel.parent, replyCount: undefined }, env));
  if (sel.omitted > 0) lines.push(`[${sel.omitted} earlier ${sel.omitted === 1 ? 'reply' : 'replies'} not shown]`);
  for (const r of sel.replies) lines.push(formatMessage(r, env));
  return lines.join('\n');
}

/** Every user id a set of messages needs a name for (authors + mentions). */
export function userIdsIn(msgs: RenderMsg[]): string[] {
  const ids = new Set<string>();
  for (const m of msgs) {
    if (m.userId && !m.botId) ids.add(m.userId);
    for (const match of (m.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(match[1]!);
  }
  return [...ids];
}
