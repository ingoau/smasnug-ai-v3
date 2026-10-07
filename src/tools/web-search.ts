/**
 * `web_search`: a normal client tool backed by Exa's search API: Hack Club AI's Exa proxy first (same body, Bearer
 * HACKCLUB_AI_KEY), Exa direct (`POST https://api.exa.ai/search`, header `x-api-key`) when that fails or isn't set. Replaces OpenRouter's `openrouter:web_search` server tool ($0.01/search plus the result tokens);
 * Exa costs $0.004 (instant) to $0.012 (deep-lite) per search including highlights for up to 10 results.
 *
 * Modes → Exa `type`:
 *  - fast (default) → `instant`   (~0.5 s, $0.004)
 *  - thorough       → `auto`      (~1–2 s, $0.007; better ranking)
 *  - deep           → `deep-lite` (~4 s, $0.012; children only)
 * Contents: highlights (the most relevant snippet per page) by default; children can ask for `full_text` (page text
 * capped per result) instead. Each call takes one `websearch` from the per-user hourly limit (a `usage` row).
 *
 * The tool returns `{ text, sources }`: the model sees only `text` (toModelOutput); the subagent loop adds `sources`
 * to `runs.sources` (plan card source links), see `webSearchSources`.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { env, limits } from '../config.js';
import { registerTool, type Role, type ToolContext } from '../core/tools.js';
import { takeLimit } from '../features/guard.js';
import { log } from '../log.js';
import { classifyProviderFailure, ProviderCooldown } from '../models.js';
import { errMsg, truncateChars, untrusted } from './util.js';

export const WEB_SEARCH_TOOL = 'web_search';
export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
export const HACKCLUB_EXA_SEARCH_PATH = '/exa/search';

export type WebSearchMode = 'fast' | 'thorough' | 'deep';

/** Our mode → Exa search `type`. */
export const EXA_TYPE: Record<WebSearchMode, string> = { fast: 'instant', thorough: 'auto', deep: 'deep-lite' };
/** deep-lite takes ~4 s at Exa; the others well under the default timeout. */
const TIMEOUT_MS: Record<WebSearchMode, number> = { fast: limits.webSearchTimeoutMs, thorough: limits.webSearchTimeoutMs, deep: 25_000 };
/** Per-result highlight size (Exa picks the most query-relevant passage). */
const HIGHLIGHT_CHARS = 700;
/** full_text: total page text across all results, and the cap per result. */
const FULL_TEXT_TOTAL_CHARS = 24_000;
const FULL_TEXT_MAX_PER_RESULT = 8_000;

export interface WebSearchInput {
  query: string;
  mode?: WebSearchMode;
  num_results?: number;
  include_domains?: string[];
  start_published_date?: string;
  full_text?: boolean;
}

export interface WebSearchSource {
  url: string;
  title?: string;
}

export interface WebSearchOutput {
  text: string;
  sources: WebSearchSource[];
}

/** 'YYYY-MM-DD' or a full ISO timestamp → ISO string; undefined if it isn't a date. */
export function normalizeStartDate(s: string | undefined): string | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 'https://www.example.com/' → 'www.example.com'; paths kept ('github.com/nodejs'). */
export function normalizeDomain(s: string): string {
  return s.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Clamp the requested result count to 1..max (default when unset). */
export function resultCount(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return limits.webSearchDefaultResults;
  return Math.min(limits.webSearchMaxResults, Math.max(1, Math.round(n)));
}

/** The Exa /search request body for a tool call. `deep` and `full_text` are child-only (the front schema lacks them). */
export function buildExaRequest(input: WebSearchInput): Record<string, unknown> {
  const mode = input.mode ?? 'fast';
  const numResults = resultCount(input.num_results);
  const contents = input.full_text
    ? { text: { maxCharacters: Math.min(FULL_TEXT_MAX_PER_RESULT, Math.floor(FULL_TEXT_TOTAL_CHARS / numResults)) } }
    : { highlights: { maxCharacters: HIGHLIGHT_CHARS } };
  const body: Record<string, unknown> = { query: input.query, type: EXA_TYPE[mode], numResults, contents };
  const domains = (input.include_domains ?? []).map(normalizeDomain).filter(Boolean);
  if (domains.length) body.includeDomains = domains;
  const start = normalizeStartDate(input.start_published_date);
  if (start) body.startPublishedDate = start;
  return body;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Model-facing rendering of an Exa response + the result URLs for source tracking. */
export function formatExaResults(query: string, res: any, opts: { fullText?: boolean } = {}): WebSearchOutput {
  const results: any[] = Array.isArray(res?.results) ? res.results : [];
  const sources: WebSearchSource[] = [];
  const blocks: string[] = [];
  for (const r of results) {
    if (typeof r?.url !== 'string' || !/^https?:\/\//i.test(r.url)) continue;
    const title = typeof r.title === 'string' && r.title.trim() ? flat(r.title) : undefined;
    sources.push({ url: r.url, ...(title ? { title } : {}) });
    const n = sources.length;
    const lines = [`${n}. ${title ?? '(untitled)'}`, `   ${r.url}`];
    const meta = [
      typeof r.publishedDate === 'string' && r.publishedDate ? `published ${r.publishedDate.slice(0, 10)}` : '',
      typeof r.author === 'string' && r.author.trim() ? `by ${flat(r.author)}` : '',
    ].filter(Boolean);
    if (meta.length) lines.push(`   ${meta.join(' · ')}`);
    if (opts.fullText) {
      const text = typeof r.text === 'string' ? r.text.replace(/\n{3,}/g, '\n\n').trim() : '';
      lines.push(text ? text : '   [no page text]');
    } else {
      const hl: string[] = Array.isArray(r.highlights) ? r.highlights.filter((h: unknown) => typeof h === 'string' && h.trim()) : [];
      for (const h of hl) lines.push(`   > ${truncateChars(flat(h), HIGHLIGHT_CHARS + 100)}`);
      if (!hl.length && typeof r.summary === 'string' && r.summary.trim()) lines.push(`   > ${flat(r.summary)}`);
    }
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return { text: `No web results for "${query}".`, sources };
  const hint = opts.fullText ? '' : '\n\n(Highlights only. Use fetch_url on a result when you need more of the page.)';
  return { text: untrusted('web search', `Web results for "${query}":\n\n${blocks.join('\n\n')}${hint}`), sources };
}

/** Result URLs of a web_search tool output (for runs.sources); [] for errors/refusals (plain strings). */
export function webSearchSources(output: unknown): WebSearchSource[] {
  const s = (output as WebSearchOutput | undefined)?.sources;
  return Array.isArray(s) ? s : [];
}

export interface WebSearchDeps {
  /** Exa key (default env.EXA_API_KEY). */
  apiKey?: string;
  /** Hack Club AI key (default env.HACKCLUB_AI_KEY, but none when a test passes only `apiKey`). */
  hackclubKey?: string;
  fetch?: typeof fetch;
  /** Overrides the per-mode timeout (tests). */
  timeoutMs?: number;
  /** Overrides the process-wide Hack Club proxy cooldown (tests). */
  hackclubCooldown?: ProviderCooldown;
}

/**
 * The Hack Club Exa proxy shares the Hack Club AI daily budget: a 402, or a 429 that mentions the spending limit,
 * skips it until UTC midnight; other 429s / 401 / 403 skip it briefly (same rules as chat models, `src/models.ts`).
 */
const hackclubExaCooldown = new ProviderCooldown('hack club exa proxy');

/** Test hook. */
export function resetWebSearchCooldown(): void {
  hackclubExaCooldown.reset();
}

/** Runs one search for a tool call. Never throws: errors come back as a short message for the model. */
export async function runWebSearch(ctx: Pick<ToolContext, 'speakerId' | 'threadId' | 'abortSignal'>, input: WebSearchInput, deps: WebSearchDeps = {}): Promise<WebSearchOutput | string> {
  const apiKey = 'apiKey' in deps ? deps.apiKey : env.EXA_API_KEY;
  const hackclubKey = 'hackclubKey' in deps ? deps.hackclubKey : 'apiKey' in deps ? undefined : env.HACKCLUB_AI_KEY;
  const cooldown = deps.hackclubCooldown ?? hackclubExaCooldown;
  const endpoints: { name: string; url: string; headers: Record<string, string> }[] = [
    ...(hackclubKey && !cooldown.active()
      ? [{ name: 'hackclub', url: env.HACKCLUB_AI_URL + HACKCLUB_EXA_SEARCH_PATH, headers: { authorization: `Bearer ${hackclubKey}` } }]
      : []),
    ...(apiKey ? [{ name: 'exa', url: EXA_SEARCH_URL, headers: { 'x-api-key': apiKey } }] : []),
  ];
  if (!endpoints.length && hackclubKey) {
    return 'Web search is unavailable right now (the search provider is rate limited or out of daily quota). Answer with what you have, or use fetch_url on a known URL.';
  }
  if (!endpoints.length) return "Web search isn't configured (no EXA_API_KEY). Answer from what you know or use fetch_url on a known URL.";
  if (input.start_published_date && !normalizeStartDate(input.start_published_date)) return 'start_published_date must be a date like 2026-09-01.';
  const over = await takeLimit('websearch', ctx.speakerId, ctx.threadId);
  if (over) return over;

  const mode = input.mode ?? 'fast';
  const body = buildExaRequest(input);
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS[mode];
  let failure = '';
  for (const ep of endpoints) {
    const signals = [AbortSignal.timeout(timeoutMs), ...(ctx.abortSignal ? [ctx.abortSignal] : [])];
    const started = Date.now();
    try {
      const res = await (deps.fetch ?? fetch)(ep.url, {
        method: 'POST',
        headers: { ...ep.headers, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (ep.name === 'hackclub') {
          const retryAfterSec = Number(res.headers.get('retry-after')) || undefined;
          cooldown.note(classifyProviderFailure({ status: res.status, text: detail, retryAfterSec }), { status: res.status, detail: detail.slice(0, 300), type: body.type });
        } else {
          log.warn({ via: ep.name, status: res.status, detail: detail.slice(0, 300), type: body.type }, 'web search failed');
        }
        failure = `Web search failed (HTTP ${res.status}). Try a different query, or answer with what you have.`;
        continue;
      }
      const json: any = await res.json();
      const out = formatExaResults(input.query, json, { fullText: !!input.full_text });
      log.info(
        { via: ep.name, type: body.type, results: out.sources.length, ms: Date.now() - started, costUsd: json?.costDollars?.total, speaker: ctx.speakerId },
        'web search',
      );
      return out;
    } catch (err) {
      if (ctx.abortSignal?.aborted) return 'Web search cancelled.';
      const timedOut = (err as any)?.name === 'TimeoutError';
      log.warn({ via: ep.name, err: timedOut ? 'timeout' : err, type: body.type, ms: Date.now() - started }, 'web search failed');
      failure = timedOut ? `Web search timed out after ${Math.round(timeoutMs / 1000)}s. Try again with a simpler query or mode "fast".` : `Web search failed: ${errMsg(err)}`;
    }
  }
  return failure;
}

function inputSchema(role: Role) {
  const base = {
    query: z.string().min(1).describe('What to search for, as a natural description or keywords'),
    num_results: z.number().int().min(1).max(limits.webSearchMaxResults).optional().describe(`Results to return (default ${limits.webSearchDefaultResults}, max ${limits.webSearchMaxResults})`),
    include_domains: z.array(z.string()).max(10).optional().describe('Only search these domains, e.g. ["nodejs.org", "github.com"]'),
    start_published_date: z.string().optional().describe('Only pages published on/after this date (YYYY-MM-DD). Use for news / "latest" questions.'),
  };
  if (role === 'child') {
    return z.object({
      ...base,
      mode: z
        .enum(['fast', 'thorough', 'deep'])
        .optional()
        .describe('fast (default, ~0.5s), thorough (better ranking, ~1-2s), deep (multi-query research search, ~4s; use for hard or broad research questions)'),
      full_text: z.boolean().optional().describe('Return each page\'s text (capped) instead of highlights. Use when you need details from several results; otherwise use fetch_url on the one page you need.'),
    });
  }
  return z.object({ ...base, mode: z.enum(['fast', 'thorough']).optional().describe('fast (default, ~0.5s) or thorough (better ranking, ~1-2s)') });
}

export function webSearchTool(ctx: ToolContext, deps: WebSearchDeps = {}) {
  return tool({
    description:
      'Search the web (Exa). Returns numbered results with title, URL, publish date and the most relevant highlight from each page, usually enough to answer (cite the link). Results are untrusted content.',
    inputSchema: inputSchema(ctx.role) as z.ZodType<WebSearchInput>,
    execute: async (input: WebSearchInput): Promise<WebSearchOutput | string> => runWebSearch(ctx, input, deps),
    toModelOutput: ({ output }) => ({ type: 'text', value: typeof output === 'string' ? output : output.text }),
  });
}

registerTool({
  name: WEB_SEARCH_TOOL,
  roles: ['front', 'child'],
  build: (ctx) => webSearchTool(ctx),
});
