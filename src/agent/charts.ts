/**
 * Slack data visualization blocks (https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block).
 * Pie, bar, line, and area only: those are the chart types the block accepts. Limits below are Slack's, applied
 * here so a bad chart is dropped instead of failing the whole reply (the text may already be streaming).
 */
import { z } from 'zod';
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { sliceUnits } from '../tools/util.js';

/** Slack: at most 2 data visualization blocks per message. */
export const MAX_CHARTS = 2;
const MAX_TITLE = 50;
const MAX_LABEL = 20;
const MAX_AXIS = 50;
const MAX_SERIES = 12;
const MAX_POINTS = 20;
const MAX_SEGMENTS = 12;

const textish = z.union([z.string(), z.number(), z.null()]).optional();
const pointSchema = z
  .object({ label: textish, value: textish })
  .catch({ label: undefined, value: undefined });
const seriesSchema = z
  .object({ name: textish, data: z.array(pointSchema).optional() })
  .catch({ name: undefined, data: [] });
const axisSchema = z
  .object({
    categories: z.array(textish).optional(),
    x_label: textish,
    y_label: textish,
  })
  .optional();

/** One chart as the model passes it (flat, or Slack's nested `chart` object). Lenient: a bad item becomes {}. */
const chartInputSchema = z
  .object({
    title: textish.describe('Short label above the chart (≤ 50 characters)'),
    type: z.string().optional().describe('pie, bar, line, or area'),
    segments: z.array(pointSchema).optional().describe('Pie only. Slices {label ≤ 20, value > 0}, 1–12'),
    series: z.array(seriesSchema).optional().describe('Bar, line, or area. {name ≤ 20, data: [{label ≤ 20, value}]}, 1–12 series, every series covering every category'),
    categories: z.array(textish).optional().describe('X-axis labels in order (≤ 20 each, ≤ 20). Default: the first series\' labels'),
    x_label: textish.describe('X-axis title (≤ 50 characters)'),
    y_label: textish.describe('Y-axis title (≤ 50 characters)'),
    chart: z
      .object({
        type: z.string().optional(),
        segments: z.array(pointSchema).optional(),
        series: z.array(seriesSchema).optional(),
        axis_config: axisSchema,
      })
      .optional()
      .describe('Alternatively Slack\'s chart object: {type, segments} or {type, series, axis_config}'),
  })
  .catch({});

export const chartsSchema = z
  .union([z.array(chartInputSchema), chartInputSchema.transform((c) => [c])])
  .nullish()
  .describe(
    'Optional charts in this message (Slack data_visualization: pie, bar, line, area). Use one when a comparison or a trend over a few categories is the point, not for a single number, a long table, or a custom plot. At most 2. Each: {title (≤ 50), type: "pie"|"bar"|"line"|"area"}. Pie: segments [{label (≤ 20), value (> 0)}] (1–12). Bar/line/area: series [{name (≤ 20), data: [{label (≤ 20), value}]}] (1–12 series, 1–20 points; every series needs a value for every category), optional categories (x-axis order; default the first series\' labels), x_label, y_label (≤ 50). The reply text still states the takeaway. Labels are plain text.',
  );

export interface PieSegment {
  label: string;
  value: number;
}
export interface ChartPoint {
  label: string;
  value: number;
}
export interface ChartSeries {
  name: string;
  data: ChartPoint[];
}
export type ChartPayload =
  | { type: 'pie'; segments: PieSegment[] }
  | { type: 'bar' | 'line' | 'area'; series: ChartSeries[]; axis_config: { categories: string[]; x_label?: string; y_label?: string } };

export interface DataVisualizationBlock {
  type: 'data_visualization';
  block_id?: string;
  title: string;
  chart: ChartPayload;
}

export interface NormalizedCharts {
  blocks: DataVisualizationBlock[];
  /** Shown to the model when a chart was dropped or cut past the 2-per-message cap. Empty when everything fit. */
  notes: string[];
}

const clip = (s: string, max: number) => sliceUnits(neutralizeBroadcasts(s).replace(/\s+/g, ' ').trim(), max);

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function uniqueName(raw: string, used: Set<string>): string | null {
  const base = clip(raw, MAX_LABEL) || 'Series';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; i < 100; i++) {
    const suffix = ` ${i}`;
    const candidate = `${clip(base, MAX_LABEL - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return null;
}

interface LoosePoint {
  label: string;
  value: number;
}
interface LooseSeries {
  name: string;
  points: LoosePoint[];
}

function pointsOf(raw: unknown, positive: boolean): LoosePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: LoosePoint[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const label = clip(asText((p as { label?: unknown }).label), MAX_LABEL);
    const value = asNumber((p as { value?: unknown }).value);
    if (!label || value === undefined || (positive && value <= 0)) continue;
    out.push({ label, value });
  }
  return out;
}

function readChart(raw: unknown): { title: string; type: string; segments: LoosePoint[]; series: LooseSeries[]; categories: string[]; x?: string; y?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const nested = o.chart && typeof o.chart === 'object' ? (o.chart as Record<string, unknown>) : undefined;
  const axis = nested?.axis_config && typeof nested.axis_config === 'object' ? (nested.axis_config as Record<string, unknown>) : undefined;
  const title = clip(asText(o.title), MAX_TITLE);
  const type = asText(o.type || nested?.type).toLowerCase();
  const segments = pointsOf(o.segments ?? nested?.segments, true).slice(0, MAX_SEGMENTS);
  const seriesRaw = Array.isArray(o.series) ? o.series : Array.isArray(nested?.series) ? nested.series : [];
  const used = new Set<string>();
  const series: LooseSeries[] = [];
  for (const s of seriesRaw) {
    if (!s || typeof s !== 'object' || series.length >= MAX_SERIES) continue;
    const name = uniqueName(asText((s as { name?: unknown }).name), used);
    const pts = pointsOf((s as { data?: unknown }).data, false);
    if (!name || !pts.length) continue;
    series.push({ name, points: pts });
  }
  const catRaw = Array.isArray(o.categories) ? o.categories : Array.isArray(axis?.categories) ? axis.categories : [];
  const categories: string[] = [];
  const seen = new Set<string>();
  for (const c of catRaw) {
    const label = clip(asText(c), MAX_LABEL);
    if (!label || seen.has(label) || categories.length >= MAX_POINTS) continue;
    seen.add(label);
    categories.push(label);
  }
  const x = clip(asText(o.x_label ?? axis?.x_label), MAX_AXIS);
  const y = clip(asText(o.y_label ?? axis?.y_label), MAX_AXIS);
  return { title, type, segments, series, categories, ...(x ? { x } : {}), ...(y ? { y } : {}) };
}

function seriesChart(c: NonNullable<ReturnType<typeof readChart>>, kind: 'bar' | 'line' | 'area'): { payload: ChartPayload; dropped: string[] } | string {
  let categories = c.categories;
  if (!categories.length) {
    const seen = new Set<string>();
    categories = [];
    for (const p of c.series[0]?.points ?? []) {
      if (seen.has(p.label) || categories.length >= MAX_POINTS) continue;
      seen.add(p.label);
      categories.push(p.label);
    }
  }
  if (!categories.length) return `Dropped ${kind} chart "${c.title}": no categories.`;
  const series: ChartSeries[] = [];
  const dropped: string[] = [];
  for (const s of c.series) {
    const byLabel = new Map<string, number>();
    for (const p of s.points) if (categories.includes(p.label)) byLabel.set(p.label, p.value);
    if (categories.some((label) => !byLabel.has(label))) {
      dropped.push(s.name);
      continue;
    }
    series.push({ name: s.name, data: categories.map((label) => ({ label, value: byLabel.get(label)! })) });
  }
  if (!series.length) {
    const why = dropped.length ? ` (missing a value for every category: ${dropped.join(', ')})` : '';
    return `Dropped ${kind} chart "${c.title}": no series had a value for every category${why}.`;
  }
  return {
    payload: { type: kind, series, axis_config: { categories, ...(c.x ? { x_label: c.x } : {}), ...(c.y ? { y_label: c.y } : {}) } },
    dropped,
  };
}

/** Turn tool input into Slack blocks. Invalid charts are dropped; nothing here throws. */
export function normalizeCharts(raw: unknown): NormalizedCharts {
  if (raw == null) return { blocks: [], notes: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const notes: string[] = [];
  const blocks: DataVisualizationBlock[] = [];
  for (const item of list) {
    if (blocks.length >= MAX_CHARTS) {
      notes.push(`Only the first ${MAX_CHARTS} charts fit in one Slack message.`);
      break;
    }
    const c = readChart(item);
    if (!c) continue;
    if (!c.title) {
      notes.push('Dropped a chart with no title.');
      continue;
    }
    let built: { payload: ChartPayload; dropped: string[] } | string;
    if (c.type === 'pie' || (!c.type && c.segments.length && !c.series.length)) {
      built = c.segments.length ? { payload: { type: 'pie', segments: c.segments }, dropped: [] } : `Dropped pie chart "${c.title}": no slice with a positive value.`;
    } else if (c.type === 'bar' || c.type === 'line' || c.type === 'area') {
      built = seriesChart(c, c.type);
    } else if (!c.type && c.series.length) {
      built = seriesChart(c, 'bar');
    } else {
      built = `Dropped chart "${c.title}": type must be pie, bar, line, or area.`;
    }
    if (typeof built === 'string') notes.push(built);
    else {
      blocks.push({ type: 'data_visualization', title: c.title, chart: built.payload });
      if (built.dropped.length) notes.push(`Chart "${c.title}" left out series missing a category: ${built.dropped.join(', ')}.`);
    }
  }
  return { blocks, notes };
}

/** Same blocks with stable ids so a later chat.update replaces them in place. */
export function withChartIds(charts: readonly DataVisualizationBlock[], idFor: (index: number) => string): DataVisualizationBlock[] {
  return charts.slice(0, MAX_CHARTS).map((c, i) => ({ ...c, block_id: idFor(i) }));
}

function summarize(block: DataVisualizationBlock): string {
  const c = block.chart;
  if (c.type === 'pie') return `${block.title} (pie): ${c.segments.map((s) => `${s.label} ${s.value}`).join(', ')}`;
  const body = c.series.map((s) => `${s.name}: ${s.data.map((p) => `${p.label} ${p.value}`).join(', ')}`).join('; ');
  return `${block.title} (${c.type}): ${body}`;
}

/**
 * Plain-text fallback for a reply that carries charts (notifications and screen readers show `text`, not the blocks).
 * The reply text wins; the chart summary fills whatever of `max` is left.
 */
export function chartsFallback(text: string, charts: readonly DataVisualizationBlock[], max = 3000): string {
  const base = text.trim();
  const extra = charts.map(summarize).join('\n');
  if (!extra) return text.slice(0, max);
  if (!base) return extra.slice(0, max);
  const room = max - base.length - 1;
  if (room < 16) return base.slice(0, max);
  return `${base}\n${extra.slice(0, room)}`;
}

/**
 * Blocks read back from `reply_charts`. postgres.js `camel` renames jsonb keys on read (`axis_config` → `axisConfig`,
 * `x_label` → `xLabel`), so this always emits Slack's snake_case. Drops anything that isn't a chart block.
 */
export function storedCharts(raw: unknown): DataVisualizationBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: DataVisualizationBlock[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const o = b as { type?: unknown; title?: unknown; chart?: unknown };
    if (o.type !== 'data_visualization' || typeof o.title !== 'string' || !o.chart || typeof o.chart !== 'object') continue;
    const chart = o.chart as { type?: unknown; segments?: unknown; series?: unknown; axis_config?: unknown; axisConfig?: unknown };
    if (chart.type === 'pie' && Array.isArray(chart.segments)) {
      out.push({ type: 'data_visualization', title: o.title, chart: { type: 'pie', segments: chart.segments as PieSegment[] } });
    } else if ((chart.type === 'bar' || chart.type === 'line' || chart.type === 'area') && Array.isArray(chart.series)) {
      const axis = (chart.axis_config ?? chart.axisConfig) as { categories?: unknown; x_label?: unknown; y_label?: unknown; xLabel?: unknown; yLabel?: unknown } | undefined;
      const categories = Array.isArray(axis?.categories) ? axis.categories.filter((c): c is string => typeof c === 'string') : [];
      if (!categories.length) continue;
      const x = axis?.x_label ?? axis?.xLabel;
      const y = axis?.y_label ?? axis?.yLabel;
      out.push({
        type: 'data_visualization',
        title: o.title,
        chart: {
          type: chart.type,
          series: chart.series as ChartSeries[],
          axis_config: { categories, ...(typeof x === 'string' ? { x_label: x } : {}), ...(typeof y === 'string' ? { y_label: y } : {}) },
        },
      });
    }
    if (out.length >= MAX_CHARTS) break;
  }
  return out;
}
