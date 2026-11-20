/**
 * Extra blocks on a reply, besides its text: charts (charts.ts), inline images, data tables, link cards, field
 * sections (two-column key/value), link button rows and containers (collapsible, boxed, plain, alert). Pure, no I/O
 * (image files are uploaded by the caller, which passes their Slack file ids in).
 *
 * Each extra has a ref (`chart:1`, `image:2`, `table:1`, `cards:1`, `fields:1`, `links:1`, `container:1`). A line in
 * the reply text that is only `[[image:2]]` places that block there (slack-markdown.ts placement markers); the rest go
 * below the text, in the order above. `[[divider]]` lines are divider blocks, and `[[buttons]]` places the reply's
 * quick-reply buttons (replyBody's `buttons`) there instead of at the bottom.
 * Every extra also has a markdown fallback: if Slack refuses the rich blocks (`invalid_blocks`: an image URL it can't
 * fetch, a block type this workspace doesn't render yet), the reply is re-sent "degraded", with the fallbacks written
 * into the text and image files attached to the message instead.
 *
 * Inputs are lenient (a bad item is dropped with a note for the model, never a schema error: the text may already be
 * streaming). Limits are Slack's (docs.slack.dev block reference), applied here.
 */
import { z } from 'zod';
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { sliceUnits } from '../tools/util.js';
import { chartSummary, normalizeCharts, type DataVisualizationBlock } from './charts.js';
import { MAX_FALLBACK_TEXT, markerRef, replyBlocks, splitMarkdown, type ReplyBlock } from './slack-markdown.js';

export type ExtraKind = 'chart' | 'image' | 'table' | 'cards' | 'fields' | 'links' | 'container';

export interface ReplyExtra {
  /** `kind:n`, the placement marker that puts it inline. */
  ref: string;
  /** The Slack block, without block_id (set per render so a chat.update replaces it in place). */
  block: Record<string, unknown>;
  /** Markdown written into the text instead when the message goes out degraded ('' = nothing). */
  fallback: string;
  /** One plain-text line for the notification/fallback `text`. */
  summary: string;
  /** Image from a file: its Slack file id, attached to the message when the reply goes out degraded. */
  slackFileId?: string;
}

export interface ReplyExtras {
  items: ReplyExtra[];
  /** Slack refused the blocks once: render the fallbacks instead. */
  degraded?: boolean;
  /** One small line shown under everything else as a context block (the response time, `footerBlock`). */
  footer?: string;
}

/** True if the extras have anything to store or render (items or a footer). */
export const hasExtras = (extras: ReplyExtras | null | undefined): extras is ReplyExtras => Boolean(extras?.items.length || extras?.footer);

/** The footer as the message's last block (a context block: small grey text), or none. */
export function footerBlock(extras: ReplyExtras | null | undefined, idPrefix = ''): { type: 'context'; block_id: string; elements: { type: 'mrkdwn'; text: string }[] }[] {
  return extras?.footer ? [{ type: 'context', block_id: `${idPrefix}reply_footer`, elements: [{ type: 'mrkdwn', text: extras.footer }] }] : [];
}

/** How long a response took, for the footer: `0.8s`, `12s`, `2m 05s`, `1h 03m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (Math.round(s) < 60) return `${Math.round(s)}s`;
  const total = Math.round(s);
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  const mins = Math.round(total / 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** A Slack message ts (`1712345678.123456`) as epoch milliseconds, or null if it isn't one. */
export function slackTsMs(ts: string): number | null {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

/**
 * The footer text of a reply delivered `ms` after the message that triggered it; `fallbackModel` (a display name) when
 * the reply came from a fallback model instead of the configured one.
 */
export const responseTimeFooter = (ms: number, fallbackModel?: string | null) =>
  `Responded in ${formatDuration(ms)}${fallbackModel ? ` · via ${fallbackModel} (fallback)` : ''}`;

export const MAX_IMAGES = 6;
export const MAX_TABLES = 2;
export const MAX_CARDS = 10;
const MAX_ALT = 300;
const MAX_IMAGE_TITLE = 150;
const MAX_URL = 3000;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_ROWS = 200;
/** Characters across all data table cells of one message (Slack: 20,000; a little headroom). */
const TABLE_CHAR_BUDGET = 19_000;
const MAX_CELL = 500;
const MAX_CAPTION = 150;
const MAX_CARD_TITLE = 150;
const MAX_CARD_BODY = 200;
const MAX_BUTTON_LABEL = 30;
/** Link buttons on one card (the plan: up to 3). */
export const MAX_CARD_BUTTONS = 3;
export const MAX_FIELD_GROUPS = 5;
/** Fields in one section block (Slack). */
const MAX_FIELDS = 10;
const MAX_FIELD_LABEL = 100;
const MAX_FIELD_VALUE = 500;
/** Characters in one field's text (Slack: 2000). */
const MAX_FIELD_TEXT = 2000;
export const MAX_LINK_ROWS = 5;
const MAX_LINK_BUTTONS = 5;
export const MAX_CONTAINERS = 5;
const MAX_CONTAINER_TITLE = 150;
const MAX_CONTAINER_SUBTITLE = 150;
/** Body text per section block inside a container (Slack: 3000). */
const MAX_SECTION_TEXT = 3000;
/** Child blocks of a container (Slack). */
const MAX_CONTAINER_CHILDREN = 10;
const MAX_ALERT_TEXT = 3000;
/** Rows of a table written into a degraded (markdown) reply. */
const FALLBACK_TABLE_ROWS = 30;

const clip = (s: string, max: number) => sliceUnits(neutralizeBroadcasts(s).replace(/\s+/g, ' ').trim(), max);
const asText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const httpsUrl = (v: unknown): string | null => {
  const s = asText(v).trim();
  if (!s || s.length > MAX_URL) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};
/** Markdown link text / table cell: no line breaks, no pipes or brackets that would break the syntax. */
const mdSafe = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/[[\]]/g, '');
/** A URL inside markdown `(…)`: parentheses escaped so they can't end the link early. */
const mdUrl = (u: string) => u.replace(/\(/g, '%28').replace(/\)/g, '%29');
/** Free text in a fallback: on one line, and never a placement marker (`[[…]]`). */
const mdLine = (s: string) => s.replace(/\s+/g, ' ').replace(/\[\[|\]\]/g, '');
/** Multi-line text in a fallback: never a placement marker. */
const mdBlock = (s: string) => s.replace(/\[\[|\]\]/g, '');
/** Multi-line text, trimmed, broadcasts neutralised, clipped (line breaks kept). */
const clipBlock = (s: string, max: number) => sliceUnits(neutralizeBroadcasts(s).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), max);

/**
 * The model's Slack-flavoured markdown as mrkdwn (section text, fields, alerts): `&<>` escaped, `**bold**` → `*bold*`,
 * `~~x~~` → `~x~`, `[text](url)` → `<url|text>`. Slack's own `<url|text>` / `<@U…>` forms written as-is are kept.
 */
export function mrkdwn(md: string): string {
  const keep: string[] = [];
  const held = (v: string) => `\u0000${keep.push(v) - 1}\u0000`;
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Code (fenced, then inline) is left as written, only escaped.
  let s = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => held(esc(m)));
  s = s.replace(/<(?:https?:\/\/[^|>\s]+(?:\|[^>]*)?|[@#!][^>\s]+)>/g, (m) => held(m));
  // URLs may hold balanced parentheses (Wikipedia's `Foo_(bar)`).
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, t: string, u: string) => held(`<${u.replace(/[<>|]/g, encodeURIComponent)}|${esc(t.replace(/[<>|]/g, ''))}>`));
  s = esc(s);
  s = s.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '*$1*').replace(/__(?=\S)([^_\n]+?)__/g, '*$1*').replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => keep[Number(i)]!);
}

/** Where to cut mrkdwn at `at` (or before) without splitting an entity (`&amp;`) or a `<…>` link. */
function safeCut(s: string, at: number): number {
  const m = /(?:&[a-z#0-9]*|<[^>\n]*)$/i.exec(s.slice(0, at));
  return m && m.index > 0 ? m.index : at;
}

/** mrkdwn clipped to `max` characters (Slack's limit for that field), never mid-entity or mid-link. */
export function clipMrkdwn(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, safeCut(s, max - 1)).trimEnd()}…`;
}

/** A link button (action_id under the `link:` prefix: Slack opens the URL; the click needs no handling). */
function linkButton(label: string, url: string, actionId: string, style?: unknown): Record<string, unknown> {
  return {
    type: 'button',
    text: { type: 'plain_text', text: clip(label, MAX_BUTTON_LABEL) || 'Open' },
    url,
    action_id: `link:${actionId}`,
    ...(style === 'primary' || style === 'danger' ? { style } : {}),
  };
}

/** Lenient link-button list: [{label, url}] (or `text` for label); bad ones reported in `notes`. */
function linkButtons(raw: unknown, max: number, idOf: (i: number) => string, notes: string[], where: string): { blocks: Record<string, unknown>[]; md: string[] } {
  const blocks: Record<string, unknown>[] = [];
  const md: string[] = [];
  if (!Array.isArray(raw)) return { blocks, md };
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    const url = httpsUrl(o.url);
    const label = clip(asText(o.label ?? o.text), MAX_BUTTON_LABEL);
    if (!url) {
      notes.push(`Dropped a button "${label || '?'}" in ${where}: it needs an http(s) url.`);
      continue;
    }
    if (blocks.length >= max) {
      notes.push(`Only ${max} buttons fit in ${where}.`);
      break;
    }
    blocks.push(linkButton(label, url, idOf(blocks.length), o.style));
    md.push(`[${mdSafe(label || 'Open')}](${mdUrl(url)})`);
  }
  return { blocks, md };
}

// ---------- Schemas (what the model passes) ----------

const textish = z.union([z.string(), z.number(), z.null()]).optional();

export const imagesSchema = z
  .array(
    z
      .object({
        file: z.string().optional().describe('An image file id (file_…): an upload, create_file, a subagent result'),
        url: z.string().optional().describe('Or a public https URL of a PNG/JPEG/GIF image'),
        alt: textish.describe('Short description of the image (required, for screen readers)'),
        title: textish.describe('Optional caption shown above the image'),
      })
      .catch({}),
  )
  .nullish()
  .describe(
    `Optional images shown inside the message (not as file attachments), up to ${MAX_IMAGES}: [{file: "file_…" | url, alt, title?}]. PNG, JPEG or GIF only. Use for a picture, screenshot or diagram the reply is about. By default they go below the text; a line that is only [[image:N]] (N = position in this list, from 1) puts image N there instead.`,
  );

const tableInputSchema = z
  .object({
    caption: textish.describe('What the table shows (required, ≤ 150 characters)'),
    columns: z.array(textish).optional().describe('Header labels, 1–20'),
    rows: z.array(z.array(textish).catch([])).optional().describe('Rows of cells (string or number), same order as columns, ≤ 200'),
  })
  .catch({});

export const tablesSchema = z
  .union([z.array(tableInputSchema), tableInputSchema.transform((t) => [t])])
  .nullish()
  .describe(
    `Optional data tables in the message (sortable, paged), up to ${MAX_TABLES}: [{caption, columns: [..], rows: [[..], ..]}]. Use for data with several columns or more than a handful of rows (comparisons, lists of results, specs), instead of a markdown table. Numbers as numbers sort numerically. ≤ 20 columns, ≤ 200 rows. Placement: below the text, or where a line [[table:N]] is.`,
  );

/** An optional string the model may also send as null. */
const optStr = z.string().nullish();
/** A list, or one item alone (taken as a list of one); null/absent → nothing. Never fails: items `.catch` on their own. */
const listOf = <T extends z.ZodTypeAny>(item: T) => z.union([z.array(item), item.transform((v) => [v])]).nullish();

const linkButtonSchema = z
  .object({ label: textish, url: optStr, style: optStr.describe('"primary" or "danger" (optional)') })
  .passthrough()
  .catch({});

const cardInputSchema = z
  .object({
    title: textish.describe('≤ 150 characters'),
    subtitle: textish.describe('Optional, ≤ 150'),
    body: textish.describe('Optional, ≤ 200, markdown links allowed'),
    image_url: optStr.describe('Optional public https image URL (hero image)'),
    icon_url: optStr.describe('Optional public https URL of a small icon shown next to the title (a logo, favicon, avatar)'),
    url: optStr.describe('Optional link: adds a button that opens it'),
    button: textish.describe('Optional label for that button (default "Open")'),
    buttons: listOf(linkButtonSchema).describe(`Optional link buttons, up to ${MAX_CARD_BUTTONS} (instead of url/button): [{label, url}]`),
  })
  .catch({});

export const cardsSchema = listOf(cardInputSchema).describe(
  `Optional link cards, shown as a horizontally scrolling carousel (one card alone if just one), up to ${MAX_CARDS}: [{title, subtitle?, body?, image_url?, icon_url?, buttons?: [{label, url}] (≤ ${MAX_CARD_BUTTONS})}]. Use for a few options or results the user picks between (products, places, articles, repos), each with its link. Not for plain data (use tables). Placement: below the text, or where a line [[cards]] is.`,
);

const fieldItemSchema = z
  .object({ label: textish.describe('Key, ≤ 100 characters'), value: textish.describe('Value, ≤ 500, markdown allowed') })
  .passthrough()
  .catch({});
const fieldGroupSchema = z
  .object({
    title: textish.describe('Optional bold heading above the fields'),
    items: listOf(fieldItemSchema).describe(`The key/value pairs, up to ${MAX_FIELDS} (shown two per row)`),
  })
  .passthrough()
  .catch({});

export const fieldsSchema = listOf(fieldGroupSchema).describe(
  `Optional key/value sections in a two-column layout, up to ${MAX_FIELD_GROUPS}: [{title?, items: [{label, value}]}] (≤ ${MAX_FIELDS} items each). Use for a handful of facts about one thing (specs, status, dates, owner, price) instead of a bulleted "Key: value" list. Placement: below the text, or where a line [[fields:N]] is. A line [[divider]] draws a divider anywhere in the text.`,
);

// Loose on purpose (rows of buttons, one flat row, {buttons: [...]}): linkExtras sorts it out.
export const linksSchema = z
  .union([z.array(z.unknown()), z.unknown().transform((v) => [v])])
  .nullish()
  .describe(
    `Optional rows of link buttons placed next to the content they belong to, up to ${MAX_LINK_ROWS} rows of ≤ ${MAX_LINK_BUTTONS}: [[{label, url, style?: "primary"|"danger"}], …]. Put a line [[links:N]] (N = row, from 1) right under the paragraph it belongs to; unplaced rows go below the text. Buttons only open their URL (for answers the user picks, use \`buttons\`).`,
  );

const containerSchema = z
  .object({
    style: optStr.describe(
      '"collapsible" (folds away, starts open), "collapsed" (folds away, starts folded), "box" (a titled group with a line under the title), "plain" (a titled group, no line), or an alert: "info", "success", "warning", "error" (a coloured callout). Default "collapsible"',
    ),
    title: textish.describe('Title (required), ≤ 150 characters'),
    subtitle: textish.describe('Optional, ≤ 150 (not on alerts)'),
    body: textish.describe('The content, markdown'),
    fields: listOf(fieldItemSchema).describe(`Optional key/value pairs under the body (≤ ${MAX_FIELDS}, not on alerts)`),
    buttons: listOf(linkButtonSchema).describe(`Optional link buttons at the bottom (≤ ${MAX_LINK_BUTTONS}, not on alerts)`),
    icon_url: optStr.describe('Optional public https icon next to the title (not on alerts)'),
    width: optStr.describe('"narrow", "standard" (default), "wide" or "full" (not on alerts)'),
  })
  .passthrough()
  .catch({});

export const containersSchema = listOf(containerSchema).describe(
  `Optional containers: titled groups of content, up to ${MAX_CONTAINERS}: [{style?, title, subtitle?, body, fields?, buttons?}]. "collapsible"/"collapsed" keep long answers tidy (details, full logs, step-by-step, sources, the long version); "box"/"plain" group related content; alert styles call out a warning, tip or result. Keep the main answer in the text; containers hold the parts people may skip. Placement: below the text, or where a line [[container:N]] is.`,
);

// ---------- Images ----------

/** An image ready for a block: a file uploaded to Slack (its id), or a public URL. */
export interface PreparedImage {
  /** Position in the model's list (1-based): its `[[image:n]]`. Default: position here. */
  n?: number;
  slackFileId?: string;
  url?: string;
  alt: string;
  title?: string;
}

export function imageExtras(images: readonly PreparedImage[]): ReplyExtra[] {
  return images.slice(0, MAX_IMAGES).map((img, i) => {
    const alt = clip(img.alt, MAX_ALT) || 'image';
    const title = img.title ? clip(img.title, MAX_IMAGE_TITLE) : '';
    const source = img.slackFileId ? { slack_file: { id: img.slackFileId } } : { image_url: img.url! };
    return {
      ref: `image:${img.n ?? i + 1}`,
      block: { type: 'image', alt_text: alt, ...source, ...(title ? { title: { type: 'plain_text', text: title } } : {}) },
      // A file image is attached to the degraded message instead; a URL image becomes a link.
      fallback: img.slackFileId ? '' : `[${mdSafe(title || alt)}](${mdUrl(img.url!)})`,
      summary: `[image: ${title || alt}]`,
      ...(img.slackFileId ? { slackFileId: img.slackFileId } : {}),
    };
  });
}

/** The URL images of the model's input (file images need an upload first; see the reply tool). */
export function urlImage(raw: { url?: unknown; alt?: unknown; title?: unknown }): PreparedImage | string {
  const url = httpsUrl(raw.url);
  if (!url) return `Dropped an image: "${asText(raw.url).slice(0, 80)}" is not an http(s) URL.`;
  return { url, alt: asText(raw.alt), ...(asText(raw.title) ? { title: asText(raw.title) } : {}) };
}

// ---------- Tables ----------

type Cell = { type: 'raw_text'; text: string } | { type: 'raw_number'; value: number; text: string };

function cell(v: unknown): Cell {
  if (typeof v === 'number' && Number.isFinite(v)) return { type: 'raw_number', value: v, text: String(v) };
  const s = clip(asText(v), MAX_CELL);
  // A plain number written as a string sorts as one too.
  if (/^-?\d+(?:\.\d+)?$/.test(s) && s.length <= 16) return { type: 'raw_number', value: Number(s), text: s };
  return { type: 'raw_text', text: s || '–' };
}

export function tableExtras(raw: unknown): { items: ReplyExtra[]; notes: string[] } {
  if (raw == null) return { items: [], notes: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const items: ReplyExtra[] = [];
  const notes: string[] = [];
  let budget = TABLE_CHAR_BUDGET;
  for (const [index, t] of list.entries()) {
    if (!t || typeof t !== 'object') continue;
    if (items.length >= MAX_TABLES) {
      notes.push(`Only the first ${MAX_TABLES} tables fit in one message.`);
      break;
    }
    const o = t as { caption?: unknown; title?: unknown; columns?: unknown; rows?: unknown };
    const caption = clip(asText(o.caption ?? o.title), MAX_CAPTION);
    const rowsIn = Array.isArray(o.rows) ? o.rows.filter((r): r is unknown[] => Array.isArray(r)) : [];
    let columns = Array.isArray(o.columns) ? o.columns.map((c) => clip(asText(c), MAX_CELL)) : [];
    const width = Math.min(MAX_TABLE_COLUMNS, Math.max(columns.length, ...rowsIn.map((r) => r.length), 0));
    if (!width || !rowsIn.length) {
      notes.push(`Dropped table "${caption || 'untitled'}": it needs columns and at least one row.`);
      continue;
    }
    columns = Array.from({ length: width }, (_, i) => columns[i] || `Column ${i + 1}`);
    const header: Cell[] = columns.map((c) => ({ type: 'raw_text', text: c }));
    let chars = columns.join('').length;
    const rows: Cell[][] = [];
    let cut = false;
    for (const r of rowsIn) {
      if (rows.length >= MAX_TABLE_ROWS) {
        cut = true;
        break;
      }
      const cells = Array.from({ length: width }, (_, i) => cell(r[i]));
      const len = cells.reduce((n, c) => n + c.text.length, 0);
      if (chars + len > budget) {
        cut = true;
        break;
      }
      chars += len;
      rows.push(cells);
    }
    if (!rows.length) {
      notes.push(`Dropped table "${caption || 'untitled'}": too much text for one message.`);
      continue;
    }
    budget -= chars;
    if (cut) notes.push(`Table "${caption || 'untitled'}" showed the first ${rows.length} of ${rowsIn.length} rows (Slack limits).`);
    if (!caption) notes.push('A table had no caption; it was shown without one.');
    const n = index + 1;
    const md = [
      `| ${columns.map(mdSafe).join(' | ')} |`,
      `|${columns.map(() => '---').join('|')}|`,
      ...rows.slice(0, FALLBACK_TABLE_ROWS).map((r) => `| ${r.map((c) => mdSafe(c.text)).join(' | ')} |`),
    ].join('\n');
    const more = rows.length > FALLBACK_TABLE_ROWS ? `\n_…and ${rows.length - FALLBACK_TABLE_ROWS} more rows_` : '';
    items.push({
      ref: `table:${n}`,
      block: { type: 'data_table', caption: caption || `Table ${n}`, page_size: Math.min(10, rows.length), row_header_column_index: 0, rows: [header, ...rows] },
      fallback: `${caption ? `**${mdSafe(caption)}**\n` : ''}${md}${more}`,
      summary: `[table${caption ? `: ${caption}` : ''}, ${rows.length} rows]`,
    });
  }
  return { items, notes };
}

// ---------- Cards ----------

export function cardExtras(raw: unknown): { items: ReplyExtra[]; notes: string[] } {
  if (!Array.isArray(raw) || !raw.length) return { items: [], notes: [] };
  const notes: string[] = [];
  const cards: Record<string, unknown>[] = [];
  const md: string[] = [];
  const titles: string[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    if (cards.length >= MAX_CARDS) {
      notes.push(`Only the first ${MAX_CARDS} cards fit in one carousel.`);
      break;
    }
    const o = c as Record<string, unknown>;
    const title = clip(asText(o.title), MAX_CARD_TITLE);
    const subtitle = clip(asText(o.subtitle), MAX_CARD_TITLE);
    const body = clip(asText(o.body), MAX_CARD_BODY);
    const image = httpsUrl(o.image_url);
    const icon = httpsUrl(o.icon_url);
    if (!title && !body) {
      notes.push('Dropped a card with neither title nor body.');
      continue;
    }
    const i = cards.length;
    // `buttons` (up to 3); the older single url/button pair is the first one when `buttons` is absent.
    const given = Array.isArray(o.buttons) && o.buttons.length ? o.buttons : o.url != null ? [{ label: o.button, url: o.url }] : [];
    const btns = linkButtons(given, MAX_CARD_BUTTONS, (k) => (k === 0 ? `card_${i + 1}` : `card_${i + 1}_${k + 1}`), notes, `card "${title || 'untitled'}"`);
    const url = (btns.blocks[0]?.url as string | undefined) ?? null;
    cards.push({
      type: 'card',
      ...(title ? { title: { type: 'plain_text', text: title } } : {}),
      ...(subtitle ? { subtitle: { type: 'plain_text', text: subtitle } } : {}),
      ...(body ? { body: { type: 'mrkdwn', text: body } } : {}),
      ...(image ? { hero_image: { type: 'image', image_url: image, alt_text: title || 'image' } } : {}),
      ...(icon ? { icon: { type: 'image', image_url: icon, alt_text: title ? `${sliceUnits(title, 140)} icon` : 'icon' } } : {}),
      ...(btns.blocks.length ? { actions: btns.blocks } : {}),
    });
    const head = title ? (url ? `**[${mdSafe(title)}](${mdUrl(url)})**` : `**${mdSafe(title)}**`) : url ? `<${url}>` : '';
    const more = btns.md.length > 1 ? `\n  ${btns.md.slice(1).join(' · ')}` : '';
    md.push(`• ${[head, subtitle && `_${mdSafe(subtitle)}_`].filter(Boolean).join(' — ')}${body ? `\n  ${mdLine(body)}` : ''}${more}`);
    titles.push(title || body.slice(0, 40));
  }
  if (!cards.length) return { items: [], notes };
  // One card stands alone; more scroll in a carousel.
  const block = cards.length === 1 ? cards[0]! : { type: 'carousel', elements: cards };
  return { items: [{ ref: 'cards:1', block, fallback: md.join('\n'), summary: `[cards: ${titles.join(', ')}]` }], notes };
}

// ---------- Fields ----------

/** Lenient key/value items as section fields (`*label*\nvalue`) and their markdown lines; empty pairs dropped. */
function fieldItems(raw: unknown, notes: string[], where: string): { fields: { type: 'mrkdwn'; text: string }[]; md: string[] } {
  const fields: { type: 'mrkdwn'; text: string }[] = [];
  const md: string[] = [];
  if (!Array.isArray(raw)) return { fields, md };
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const label = clip(asText(o.label ?? o.key ?? o.name), MAX_FIELD_LABEL);
    const value = clipBlock(asText(o.value), MAX_FIELD_VALUE);
    if (!label && !value) continue;
    if (fields.length >= MAX_FIELDS) {
      notes.push(`Only ${MAX_FIELDS} fields fit in ${where}.`);
      break;
    }
    fields.push({ type: 'mrkdwn', text: clipMrkdwn([label && `*${mrkdwn(label)}*`, value && mrkdwn(value)].filter(Boolean).join('\n'), MAX_FIELD_TEXT) });
    md.push(`- ${label ? `**${mdLine(label)}:** ` : ''}${mdLine(value)}`);
  }
  return { fields, md };
}

export function fieldExtras(raw: unknown): { items: ReplyExtra[]; notes: string[] } {
  if (!Array.isArray(raw) || !raw.length) return { items: [], notes: [] };
  const items: ReplyExtra[] = [];
  const notes: string[] = [];
  for (const [index, g] of raw.entries()) {
    if (!g || typeof g !== 'object') continue;
    if (items.length >= MAX_FIELD_GROUPS) {
      notes.push(`Only the first ${MAX_FIELD_GROUPS} field sections fit in one message.`);
      break;
    }
    const o = g as Record<string, unknown>;
    const title = clip(asText(o.title), MAX_CONTAINER_TITLE);
    const { fields, md } = fieldItems(o.items ?? o.fields, notes, `field section "${title || index + 1}"`);
    if (!fields.length) {
      notes.push(`Dropped field section "${title || index + 1}": it has no items.`);
      continue;
    }
    items.push({
      ref: `fields:${index + 1}`,
      block: { type: 'section', ...(title ? { text: { type: 'mrkdwn', text: `*${mrkdwn(title)}*` } } : {}), fields },
      fallback: `${title ? `**${mdLine(title)}**\n` : ''}${md.join('\n')}`,
      summary: `[${title || 'fields'}: ${fields.length} items]`,
    });
  }
  return { items, notes };
}

// ---------- Link button rows ----------

export function linkExtras(raw: unknown): { items: ReplyExtra[]; notes: string[] } {
  if (!Array.isArray(raw) || !raw.length) return { items: [], notes: [] };
  const items: ReplyExtra[] = [];
  const notes: string[] = [];
  // A flat list of buttons (one row) is taken as that row.
  const rows = raw.every((r) => r && typeof r === 'object' && !Array.isArray(r) && 'url' in (r as object)) ? [raw] : raw;
  for (const [index, r] of rows.entries()) {
    if (items.length >= MAX_LINK_ROWS) {
      notes.push(`Only the first ${MAX_LINK_ROWS} rows of link buttons fit in one message.`);
      break;
    }
    const list = Array.isArray(r) ? r : r && typeof r === 'object' ? (r as { buttons?: unknown }).buttons : null;
    const n = index + 1;
    const { blocks, md } = linkButtons(list, MAX_LINK_BUTTONS, (k) => `links_${n}_${k + 1}`, notes, `link row ${n}`);
    if (!blocks.length) continue;
    items.push({
      ref: `links:${n}`,
      block: { type: 'actions', elements: blocks },
      fallback: md.join(' · '),
      summary: `[links: ${blocks.map((b) => (b.text as { text: string }).text).join(', ')}]`,
    });
  }
  return { items, notes };
}

// ---------- Containers ----------

const ALERT_LEVELS = new Set(['info', 'success', 'warning', 'error']);
const WIDTHS = new Set(['narrow', 'standard', 'wide', 'full']);

/** Text cut into pieces of at most `max` characters, at a paragraph or line break where possible. */
function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf('\n\n', max), rest.lastIndexOf('\n', max));
    const at = cut > max / 2 ? cut : safeCut(rest, max);
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.trim()) out.push(rest.trim());
  return out.filter(Boolean);
}

export function containerExtras(raw: unknown): { items: ReplyExtra[]; notes: string[] } {
  if (raw == null) return { items: [], notes: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const items: ReplyExtra[] = [];
  const notes: string[] = [];
  for (const [index, c] of list.entries()) {
    if (!c || typeof c !== 'object') continue;
    if (items.length >= MAX_CONTAINERS) {
      notes.push(`Only the first ${MAX_CONTAINERS} containers fit in one message.`);
      break;
    }
    const n = index + 1;
    const o = c as Record<string, unknown>;
    const style = asText(o.style ?? o.kind ?? o.type).trim().toLowerCase() || 'collapsible';
    const title = clip(asText(o.title), MAX_CONTAINER_TITLE);
    const body = clipBlock(asText(o.body ?? o.text), MAX_SECTION_TEXT * 4);
    const label = title || `container ${n}`;
    if (ALERT_LEVELS.has(style) || style === 'alert') {
      if (!title && !body) {
        notes.push(`Dropped an empty alert (${n}).`);
        continue;
      }
      const level = style === 'alert' ? 'info' : style;
      const text = clipMrkdwn([title && `*${mrkdwn(title)}*`, body && mrkdwn(body)].filter(Boolean).join('\n'), MAX_ALERT_TEXT);
      items.push({
        ref: `container:${n}`,
        block: { type: 'alert', level, text: { type: 'mrkdwn', text } },
        fallback: `> ${[title && `**${mdLine(title)}**`, body && mdBlock(body)].filter(Boolean).join('\n').replace(/\n/g, '\n> ')}`,
        summary: `[${level}: ${title || body.slice(0, 60)}]`,
      });
      continue;
    }
    const kind = style === 'collapsed' || style === 'box' || style === 'plain' ? style : 'collapsible';
    if (kind !== style) notes.push(`Container "${label}": unknown style "${style}", shown as collapsible.`);
    if (!title) {
      notes.push(`Dropped container ${n}: it needs a title.`);
      continue;
    }
    const subtitle = clip(asText(o.subtitle), MAX_CONTAINER_SUBTITLE);
    const icon = httpsUrl(o.icon_url);
    const width = asText(o.width).trim().toLowerCase();
    const fields = fieldItems(o.fields, notes, `container "${label}"`);
    const buttons = linkButtons(o.buttons, MAX_LINK_BUTTONS, (k) => `container_${n}_${k + 1}`, notes, `container "${label}"`);
    // Room for the fields and buttons; the body gets the rest of the 10 children.
    const room = MAX_CONTAINER_CHILDREN - (fields.fields.length ? 1 : 0) - (buttons.blocks.length ? 1 : 0);
    let parts = body ? chunks(mrkdwn(body), MAX_SECTION_TEXT) : [];
    if (parts.length > room) {
      notes.push(`Container "${label}": its body was cut (too long).`);
      parts = parts.slice(0, room);
    }
    const children: Record<string, unknown>[] = [
      ...parts.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
      ...(fields.fields.length ? [{ type: 'section', fields: fields.fields }] : []),
      ...(buttons.blocks.length ? [{ type: 'actions', elements: buttons.blocks }] : []),
    ];
    if (!children.length) {
      notes.push(`Dropped container "${label}": it has no content.`);
      continue;
    }
    items.push({
      ref: `container:${n}`,
      block: {
        type: 'container',
        title: { type: 'plain_text', text: title },
        ...(subtitle ? { subtitle: { type: 'mrkdwn', text: clipMrkdwn(mrkdwn(subtitle), MAX_CONTAINER_SUBTITLE) } } : {}),
        ...(icon ? { icon: { type: 'image', image_url: icon, alt_text: `${sliceUnits(title, 140)} icon` } } : {}),
        ...(WIDTHS.has(width) ? { width } : {}),
        ...(kind === 'collapsible' || kind === 'collapsed' ? { is_collapsible: true } : {}),
        ...(kind === 'collapsed' ? { default_collapsed: true } : {}),
        ...(kind === 'box' ? { has_header_divider: true } : {}),
        child_blocks: children,
      },
      fallback: [`**${mdLine(title)}**${subtitle ? ` — _${mdLine(subtitle)}_` : ''}`, body && mdBlock(body), fields.md.join('\n'), buttons.md.join(' · ')].filter(Boolean).join('\n'),
      summary: `[${title}]`,
    });
  }
  return { items, notes };
}

// ---------- Charts ----------

export function chartExtra(b: DataVisualizationBlock, i: number): ReplyExtra {
  const s = chartSummary(b);
  return { ref: `chart:${i + 1}`, block: { type: b.type, title: b.title, chart: b.chart }, fallback: `_${s.replace(/[_*]/g, '')}_`, summary: s };
}

export function chartExtras(raw: unknown): { items: ReplyExtra[]; notes: string[] } {
  const { blocks, notes } = normalizeCharts(raw);
  return { items: blocks.map(chartExtra), notes };
}

// ---------- Rendering ----------

export const isMarkerLine = (line: string) => markerRef(line) !== null;
/** The text without its placement marker lines (what a reader sees of it). */
export const withoutMarkers = (text: string) =>
  text
    .split('\n')
    .filter((l) => !isMarkerLine(l))
    .join('\n');

/** Refs placed inline by the text's marker lines. */
function placedRefs(text: string): Set<string> {
  return new Set(splitMarkdown(text).flatMap((s) => (s.kind === 'marker' ? [s.ref] : [])));
}

/** A placed `[[buttons]]` marker's ref, and the divider marker's (every `[[divider]]` line is its own divider). */
const BUTTONS_REF = 'buttons:1';
const isDividerRef = (ref: string) => ref.startsWith('divider:');

/** True if the text places something with a marker that isn't an extra (dividers, the quick-reply buttons). */
export const hasLayoutMarkers = (text: string) => splitMarkdown(text).some((s) => s.kind === 'marker' && (s.ref === BUTTONS_REF || isDividerRef(s.ref)));

/**
 * A reply's text plus its extras as message blocks: [text with inline extras, remaining extras, buttons]. `maxBlocks`
 * is what the text and extras may use together (not counting `buttons`); `idPrefix` makes the block ids (stable
 * across re-renders of one message). `buttons` (the quick-reply row, or the note that replaced it) goes where a
 * `[[buttons]]` line is, else last. Degraded: the extras' markdown fallbacks instead of their blocks (inline where
 * placed, else below the text).
 */
export function replyBody(text: string, extras: ReplyExtras | null | undefined, opts: { maxBlocks: number; idPrefix: string; buttons?: object | null }): ReplyBlock[] {
  const items = extras?.items ?? [];
  const byRef = new Map(items.map((it) => [it.ref, it]));
  const used = new Set<string>();
  const buttons = (opts.buttons ?? null) as ReplyBlock | null;
  const placed = placedRefs(text);
  let dividers = 0;
  /** Markers that aren't extras: dividers and the quick-reply buttons (once). Undefined: not one of them. */
  const layoutMarker = (ref: string): { block: unknown } | null | undefined => {
    if (isDividerRef(ref)) return { block: { type: 'divider', block_id: `${opts.idPrefix}divider_${++dividers}` } };
    if (ref !== BUTTONS_REF) return undefined;
    if (!buttons || used.has(ref)) return null;
    used.add(ref);
    return { block: buttons };
  };
  /**
   * The text's blocks within `budget` (not counting the buttons): a placed buttons row gets one block on top, but if
   * the text folded past the limit and the row fell into the folded part, it is rendered again without that block
   * (the row then goes last), so the text never takes more than `budget`.
   */
  const renderText = (src: string, budget: number, resolveExtra: (ref: string) => { block: unknown } | { markdown: string } | null) => {
    const once = (bonus: number) => {
      used.clear();
      dividers = 0;
      return replyBlocks(src, {
        maxBlocks: Math.max(1, budget) + bonus,
        resolve: (ref) => {
          const lm = layoutMarker(ref);
          return lm !== undefined ? lm : resolveExtra(ref);
        },
      });
    };
    const withBonus = buttons && placed.has(BUTTONS_REF);
    const first = once(withBonus ? 1 : 0);
    return withBonus && !first.includes(buttons!) ? once(0) : first;
  };
  /** The buttons row last when the text didn't place it. */
  const withButtons = (blocks: ReplyBlock[]) => (buttons && !blocks.includes(buttons) ? [...blocks, buttons] : blocks);
  if (extras?.degraded) {
    const rest = items.filter((it) => !placed.has(it.ref) && it.fallback).map((it) => it.fallback);
    const full = [text.trimEnd(), ...rest].filter((s) => s.trim()).join('\n\n');
    if (!full.trim()) return withButtons([]);
    return withButtons(
      renderText(full, opts.maxBlocks, (ref) => {
        const it = byRef.get(ref);
        if (!it || used.has(ref)) return null;
        used.add(ref);
        return it.fallback ? { markdown: it.fallback } : null;
      }),
    );
  }
  const idOf = (it: ReplyExtra) => `${opts.idPrefix}${it.ref.replace(':', '_')}`;
  const blockOf = (it: ReplyExtra) => ({ ...it.block, block_id: idOf(it) }) as unknown as ReplyBlock;
  // Room for the extras below the text; placed ones count inside the text's own budget.
  const render = (reserve: number) =>
    withoutMarkers(text).trim()
      ? renderText(text, opts.maxBlocks - reserve, (ref) => {
          const it = byRef.get(ref);
          if (!it || used.has(ref)) return null;
          used.add(ref);
          return { block: blockOf(it) };
        })
      : [];
  const shownIn = (blocks: ReplyBlock[]) => new Set(blocks.map((b) => (b as { block_id?: string }).block_id).filter(Boolean));
  const own = (blocks: ReplyBlock[]) => blocks.filter((b) => b !== buttons);
  let body = render(items.filter((it) => !placed.has(it.ref)).length);
  // A placed extra that didn't fit (the text was folded into one block past the limit) goes below instead, with
  // room made for it.
  let shown = shownIn(body);
  const missing = items.filter((it) => !shown.has(idOf(it))).length;
  if (missing + own(body).length > opts.maxBlocks) {
    // Room for every extra below: whatever the text keeps inline, the rest always fits.
    body = render(items.length);
    shown = shownIn(body);
  }
  const rest = items.filter((it) => !shown.has(idOf(it))).map(blockOf);
  // Within the limit by construction; the cut is a safety net that never drops the buttons row.
  let room = opts.maxBlocks;
  const out = [...body, ...rest].filter((b) => b === buttons || room-- > 0);
  return withButtons(out);
}

/**
 * The plain-text `text` of a reply with extras (notifications, screen readers): the text without marker lines, then
 * one summary line per extra, in whatever of `max` is left.
 */
export function extrasFallback(text: string, extras: ReplyExtras | null | undefined, max = MAX_FALLBACK_TEXT): string {
  const base = withoutMarkers(text).trim();
  const extra = (extras?.items ?? []).map((it) => it.summary).join('\n');
  if (!extra) return base.slice(0, max);
  if (!base) return extra.slice(0, max);
  const room = max - base.length - 1;
  if (room < 16) return base.slice(0, max);
  return `${base}\n${extra.slice(0, room)}`;
}

/** Slack file ids to attach to a degraded message (its file images, which can't be shown inline then). */
export function degradedFileIds(extras: ReplyExtras | null | undefined): string[] {
  if (!extras?.degraded) return [];
  return extras.items.flatMap((it) => (it.slackFileId ? [it.slackFileId] : []));
}

/** Stored form (reply_extras): plain JSON text, so the camelCase transform never touches block keys. */
export function serializeExtras(extras: ReplyExtras): string {
  return JSON.stringify({ items: extras.items, ...(extras.degraded ? { degraded: true } : {}), ...(extras.footer ? { footer: extras.footer } : {}) });
}

export function parseExtras(raw: unknown): ReplyExtras | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const o = JSON.parse(raw) as { items?: unknown; degraded?: unknown; footer?: unknown };
    if (!Array.isArray(o.items)) return null;
    const items = o.items.filter(
      (it): it is ReplyExtra =>
        !!it && typeof it === 'object' && typeof (it as ReplyExtra).ref === 'string' && !!(it as ReplyExtra).block && typeof (it as ReplyExtra).block === 'object',
    );
    return {
      items: items.map((it) => ({ ...it, fallback: String(it.fallback ?? ''), summary: String(it.summary ?? '') })),
      ...(o.degraded === true ? { degraded: true } : {}),
      ...(typeof o.footer === 'string' && o.footer ? { footer: o.footer } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * All extras of a reply in render order (charts, images, fields, tables, containers, cards, link rows), with the notes
 * for the model.
 */
export function buildExtras(input: {
  charts?: unknown;
  images?: readonly PreparedImage[];
  tables?: unknown;
  cards?: unknown;
  fields?: unknown;
  links?: unknown;
  containers?: unknown;
}): { extras: ReplyExtras; notes: string[] } {
  const charts = chartExtras(input.charts);
  const fields = fieldExtras(input.fields);
  const tables = tableExtras(input.tables);
  const containers = containerExtras(input.containers);
  const cards = cardExtras(input.cards);
  const links = linkExtras(input.links);
  return {
    extras: { items: [...charts.items, ...imageExtras(input.images ?? []), ...fields.items, ...tables.items, ...containers.items, ...cards.items, ...links.items] },
    notes: [...charts.notes, ...fields.notes, ...tables.notes, ...containers.notes, ...cards.notes, ...links.notes],
  };
}
