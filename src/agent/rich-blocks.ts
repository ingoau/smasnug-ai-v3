/**
 * Extra blocks on a reply, besides its text: charts (charts.ts), inline images, data tables, and link cards. Pure,
 * no I/O (image files are uploaded by the caller, which passes their Slack file ids in).
 *
 * Each extra has a ref (`chart:1`, `image:2`, `table:1`, `cards:1`). A line in the reply text that is only `[[image:2]]`
 * places that block there (slack-markdown.ts placement markers); the rest go below the text, in the order above.
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

export type ExtraKind = 'chart' | 'image' | 'table' | 'cards';

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
}

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

const cardInputSchema = z
  .object({
    title: textish.describe('≤ 150 characters'),
    subtitle: textish.describe('Optional, ≤ 150'),
    body: textish.describe('Optional, ≤ 200, markdown links allowed'),
    image_url: z.string().optional().describe('Optional public https image URL (hero image)'),
    url: z.string().optional().describe('Optional link: adds a button that opens it'),
    button: textish.describe('Optional label for that button (default "Open")'),
  })
  .catch({});

export const cardsSchema = z
  .array(cardInputSchema)
  .nullish()
  .describe(
    `Optional link cards, shown as a horizontally scrolling carousel (one card alone if just one), up to ${MAX_CARDS}: [{title, subtitle?, body?, image_url?, url?, button?}]. Use for a few options or results the user picks between (products, places, articles, repos), each with its link. Not for plain data (use tables). Placement: below the text, or where a line [[cards]] is.`,
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
      fallback: img.slackFileId ? '' : `[${mdSafe(title || alt)}](${img.url})`,
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
    const url = httpsUrl(o.url);
    if (!title && !body) {
      notes.push('Dropped a card with neither title nor body.');
      continue;
    }
    const i = cards.length;
    cards.push({
      type: 'card',
      block_id: `card_${i + 1}`,
      ...(title ? { title: { type: 'plain_text', text: title } } : {}),
      ...(subtitle ? { subtitle: { type: 'plain_text', text: subtitle } } : {}),
      ...(body ? { body: { type: 'mrkdwn', text: body } } : {}),
      ...(image ? { hero_image: { type: 'image', image_url: image, alt_text: title || 'image' } } : {}),
      ...(url
        ? { actions: [{ type: 'button', text: { type: 'plain_text', text: clip(asText(o.button), MAX_BUTTON_LABEL) || 'Open' }, url, action_id: `link:card_${i + 1}` }] }
        : {}),
    });
    const head = title ? (url ? `**[${mdSafe(title)}](${url})**` : `**${mdSafe(title)}**`) : url ? `<${url}>` : '';
    md.push(`• ${[head, subtitle && `_${mdSafe(subtitle)}_`].filter(Boolean).join(' — ')}${body ? `\n  ${body.replace(/\n/g, ' ')}` : ''}`);
    titles.push(title || body.slice(0, 40));
  }
  if (!cards.length) return { items: [], notes };
  // One card stands alone; more scroll in a carousel.
  const block = cards.length === 1 ? (({ block_id: _id, ...card }) => card)(cards[0]!) : { type: 'carousel', elements: cards };
  return { items: [{ ref: 'cards:1', block, fallback: md.join('\n'), summary: `[cards: ${titles.join(', ')}]` }], notes };
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
const withoutMarkers = (text: string) =>
  text
    .split('\n')
    .filter((l) => !isMarkerLine(l))
    .join('\n');

/** Refs placed inline by the text's marker lines. */
function placedRefs(text: string): Set<string> {
  return new Set(splitMarkdown(text).flatMap((s) => (s.kind === 'marker' ? [s.ref] : [])));
}

/**
 * A reply's text plus its extras as message blocks: [text with inline extras, remaining extras]. `maxBlocks` is what
 * the text and extras may use together; `idPrefix` makes the block ids (stable across re-renders of one message).
 * Degraded: the extras' markdown fallbacks instead of their blocks (inline where placed, else below the text).
 */
export function replyBody(text: string, extras: ReplyExtras | null | undefined, opts: { maxBlocks: number; idPrefix: string }): ReplyBlock[] {
  const items = extras?.items ?? [];
  const byRef = new Map(items.map((it) => [it.ref, it]));
  const used = new Set<string>();
  if (extras?.degraded) {
    const placed = placedRefs(text);
    const rest = items.filter((it) => !placed.has(it.ref) && it.fallback).map((it) => it.fallback);
    const full = [text.trimEnd(), ...rest].filter((s) => s.trim()).join('\n\n');
    if (!full.trim()) return [];
    return replyBlocks(full, {
      maxBlocks: opts.maxBlocks,
      resolve: (ref) => {
        const it = byRef.get(ref);
        if (!it || used.has(ref)) return null;
        used.add(ref);
        return it.fallback ? { markdown: it.fallback } : null;
      },
    });
  }
  const blockOf = (it: ReplyExtra) => ({ ...it.block, block_id: `${opts.idPrefix}${it.ref.replace(':', '_')}` }) as unknown as ReplyBlock;
  const body = withoutMarkers(text).trim()
    ? replyBlocks(text, {
        maxBlocks: Math.max(1, opts.maxBlocks - items.length),
        resolve: (ref) => {
          const it = byRef.get(ref);
          if (!it || used.has(ref)) return null;
          used.add(ref);
          return { block: blockOf(it) };
        },
      })
    : [];
  const rest = items.filter((it) => !used.has(it.ref)).map(blockOf);
  return [...body, ...rest].slice(0, opts.maxBlocks);
}

/**
 * The plain-text `text` of a reply with extras (notifications, screen readers): the text without marker lines, then
 * one summary line per extra, in whatever of `max` is left.
 */
export function extrasFallback(text: string, extras: ReplyExtras | null | undefined, max = MAX_FALLBACK_TEXT): string {
  const base = withoutMarkers(text).trim();
  const extra = (extras?.items ?? []).map((it) => it.summary).join('\n');
  if (!extra) return base.slice(0, max) || text.slice(0, max);
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
  return JSON.stringify({ items: extras.items, ...(extras.degraded ? { degraded: true } : {}) });
}

export function parseExtras(raw: unknown): ReplyExtras | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const o = JSON.parse(raw) as { items?: unknown; degraded?: unknown };
    if (!Array.isArray(o.items)) return null;
    const items = o.items.filter(
      (it): it is ReplyExtra =>
        !!it && typeof it === 'object' && typeof (it as ReplyExtra).ref === 'string' && !!(it as ReplyExtra).block && typeof (it as ReplyExtra).block === 'object',
    );
    return { items: items.map((it) => ({ ...it, fallback: String(it.fallback ?? ''), summary: String(it.summary ?? '') })), ...(o.degraded === true ? { degraded: true } : {}) };
  } catch {
    return null;
  }
}

/** All extras of a reply in render order (charts, images, tables, cards), with the notes for the model. */
export function buildExtras(input: { charts?: unknown; images?: readonly PreparedImage[]; tables?: unknown; cards?: unknown }): { extras: ReplyExtras; notes: string[] } {
  const charts = chartExtras(input.charts);
  const tables = tableExtras(input.tables);
  const cards = cardExtras(input.cards);
  return {
    extras: { items: [...charts.items, ...imageExtras(input.images ?? []), ...tables.items, ...cards.items] },
    notes: [...charts.notes, ...tables.notes, ...cards.notes],
  };
}
