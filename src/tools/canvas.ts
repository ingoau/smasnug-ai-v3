/**
 * Canvas helpers (pure, no I/O): canvas id/link parsing, the read/edit access rules, markdown conversion between
 * Slack message syntax and canvas markdown, and section splicing for edit_canvas. The tools live in canvases.ts.
 *
 * Canvas markdown (docs.slack.dev/surfaces/canvases): mentions are `![](@U123)` / `![](#C123)`, headings h1-h3,
 * tables up to 300 cells, 1 MiB per document_content. Block Kit isn't supported.
 */
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';

const CANVAS_ID = /^F[A-Z0-9]{6,}$/;

/**
 * A canvas id from what the model passes: a bare `F…` id, a canvas link (`https://<ws>.slack.com/docs/T…/F…`,
 * `https://app.slack.com/docs/T…/F…`), a file permalink (`https://<ws>.slack.com/files/U…/F…/name`), each also in
 * Slack's `<url|label>` form. Undefined for anything else.
 */
export function parseCanvasId(input: string | undefined | null): string | undefined {
  const s = (input ?? '').trim().replace(/^<|>$/g, '').split('|')[0]!.trim();
  if (CANVAS_ID.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (!/(^|\.)slack\.com$/i.test(u.hostname)) return undefined;
  const m = /\/docs\/[TE][A-Z0-9]+\/(F[A-Z0-9]+)(?:\/|$)/.exec(u.pathname) ?? /\/files\/[UWB][A-Z0-9]+\/(F[A-Z0-9]+)(?:\/|$)/.exec(u.pathname);
  return m && CANVAS_ID.test(m[1]!) ? m[1] : undefined;
}

/** The fields of a files.info `file` object the access rule needs (docs.slack.dev/reference/objects/file-object). */
export interface CanvasFileInfo {
  id?: string;
  title?: string;
  name?: string;
  permalink?: string;
  channels?: string[];
  groups?: string[];
  ims?: string[];
  shares?: { public?: Record<string, unknown>; private?: Record<string, unknown> };
  linked_channel_id?: string;
}

/** Every conversation the canvas is shared in or linked to (channels, private groups, DMs, shares, channel tab). */
export function canvasConversations(file: CanvasFileInfo): Set<string> {
  const out = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && /^[CGD][A-Z0-9]+$/.test(id)) out.add(id);
  };
  for (const id of [...(file.channels ?? []), ...(file.groups ?? []), ...(file.ims ?? [])]) add(id);
  for (const id of Object.keys(file.shares?.public ?? {})) add(id);
  for (const id of Object.keys(file.shares?.private ?? {})) add(id);
  add(file.linked_channel_id);
  return out;
}

/**
 * Conversations worth a public check: everything but DMs. Membership in `channels` / `shares.public` isn't trusted
 * on its own (newer private channels have C… ids too): callers verify each via conversations.info.
 */
export function publicCandidates(file: CanvasFileInfo): string[] {
  return [...canvasConversations(file)].filter((id) => !id.startsWith('D'));
}

/** A row of `bot_canvases` (a canvas the bot created). */
export interface BotCanvasRow {
  canvasId: string;
  channelId: string;
  threadId: string;
  creatorId: string;
  title: string;
  permalink: string | null;
}

export type CanvasAccess = { ok: true; via: 'bot_created' | 'this_conversation' | 'public_channel' } | { ok: false };

/**
 * read_canvas access rule (fail closed). Allowed when:
 * - the bot created it and it was created in this conversation, or for the speaker, or in a verified public channel;
 * - it is shared in / linked to the current conversation (files.info as seen by the bot token);
 * - it is shared in / linked to a verified public channel.
 * `publicIds` holds the ids verified public via conversations.info; anything unverified counts as private.
 */
export function decideCanvasAccess(o: {
  row?: Pick<BotCanvasRow, 'channelId' | 'creatorId'> | null;
  file?: CanvasFileInfo | null;
  channelId: string;
  speakerId: string;
  publicIds: Set<string>;
}): CanvasAccess {
  if (o.row && (o.row.channelId === o.channelId || o.row.creatorId === o.speakerId || o.publicIds.has(o.row.channelId))) {
    return { ok: true, via: 'bot_created' };
  }
  if (!o.file) return { ok: false };
  const convs = canvasConversations(o.file);
  if (convs.has(o.channelId)) return { ok: true, via: 'this_conversation' };
  for (const id of convs) if (!id.startsWith('D') && o.publicIds.has(id)) return { ok: true, via: 'public_channel' };
  return { ok: false };
}

/**
 * edit_canvas rule: only canvases the bot created, and only for the speaker who asked for them (their deliverable).
 * Being in the same channel isn't enough: anyone there could otherwise get the bot to rewrite someone else's canvas.
 */
export function canEditCanvas(row: Pick<BotCanvasRow, 'creatorId'> | null | undefined, speakerId: string): boolean {
  return !!row && row.creatorId === speakerId;
}

/** Split markdown into alternating prose / fenced-code segments (code segments include their fences). */
function segments(md: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|(?![\s\S]))/gm;
  let last = 0;
  for (const m of md.matchAll(re)) {
    if (m.index! > last) out.push({ code: false, text: md.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) });
  return out;
}

/**
 * Model markdown (Slack message syntax) → canvas markdown. Group pings are neutralised everywhere (the bot never
 * notifies a group, also not via a canvas): `<!here>`, `<!subteam^S…>`, bare `@channel`, and the canvas forms
 * `![](@S…)` / `![](!here)`. Outside code: `<@U…>` → `![](@U…)`, `<#C…|name>` → `![](#C…)`, `<url|text>` →
 * `[text](url)`, `<url>` → `url`.
 */
export function toCanvasMarkdown(md: string): string {
  return segments(md)
    .map(({ code, text }) => {
      let t = neutralizeBroadcasts(text)
        .replace(/!\[[^\]]*\]\(\s*@(S[A-Z0-9]+)\s*\)/g, '@​group')
        .replace(/!\[[^\]]*\]\(\s*!(here|channel|everyone|subteam[^)]*)\s*\)/gi, (_m, w: string) => `@​${w.startsWith('subteam') ? 'group' : w}`);
      if (code) return t;
      t = t
        .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, '![](@$1)')
        .replace(/<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/g, '![](#$1)')
        .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g, '[$2]($1)')
        .replace(/<((?:https?|mailto):[^|>\s]+)>/g, '$1');
      return t;
    })
    .join('');
}

/** Canvas markdown → the syntax the agents read everywhere else (`<@U…>`, `<#C…>`). */
export function fromCanvasMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/!\[[^\]]*\]\(\s*@([UW][A-Z0-9]+)\s*\)/g, '<@$1>')
    .replace(/!\[[^\]]*\]\(\s*#([CG][A-Z0-9]+)\s*\)/g, '<#$1>')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** A window of canvas text: `[offset, offset + maxChars)`, cut at a line break where possible, with a note on what's left. */
export function canvasWindow(text: string, offset: number, maxChars: number): { body: string; next?: number } {
  const start = Math.max(0, Math.min(offset, text.length));
  if (text.length - start <= maxChars) return { body: text.slice(start) };
  let end = start + maxChars;
  const nl = text.lastIndexOf('\n', end);
  if (nl > start + maxChars * 0.8) end = nl;
  return { body: text.slice(start, end), next: end };
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const norm = (s: string) =>
  s
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

interface Heading {
  line: number;
  level: number;
  text: string;
}

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = /^(```|~~~)/.exec(l);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (l.startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const m = HEADING.exec(l);
    if (m) out.push({ line: i, level: m[1]!.length, text: m[2]! });
  });
  return out;
}

/**
 * Replace one section of a markdown document: the section under the heading matching `heading` (exact match
 * preferred, else the only heading containing it; case/formatting-insensitive) up to the next heading of the same
 * or a higher level. The heading line is kept unless `body` starts with a heading of its own.
 */
export function spliceSection(md: string, heading: string, body: string): { markdown: string } | { error: string } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const all = headings(lines);
  const want = norm(heading.replace(/^#+\s*/, ''));
  if (!want) return { error: 'Pass the heading text of the section to replace.' };
  const exact = all.filter((h) => norm(h.text) === want);
  const matches = exact.length ? exact : all.filter((h) => norm(h.text).includes(want));
  if (!matches.length) {
    const list = all.slice(0, 30).map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n');
    return { error: `No heading matching "${heading}" in the canvas.${list ? ` Its headings:\n${list}` : ' It has no headings.'}` };
  }
  if (matches.length > 1) return { error: `${matches.length} headings match "${heading}": ${matches.map((h) => `"${h.text}"`).join(', ')}. Pass the exact heading text.` };
  const h = matches[0]!;
  const next = all.find((x) => x.line > h.line && x.level <= h.level);
  const end = next ? next.line : lines.length;
  const newBody = body.replace(/\s+$/, '');
  const replacesHeading = HEADING.test(newBody.split('\n').find((l) => l.trim()) ?? '');
  const replacement = replacesHeading ? [newBody, ''] : [lines[h.line]!, '', newBody, ''];
  if (!next) replacement.pop();
  return { markdown: [...lines.slice(0, h.line), ...replacement, ...lines.slice(end)].join('\n') };
}
