/**
 * Deferred connector tools (docs/mcp-custom-connectors.md, "Tool search"): the pure parts. When a speaker's connector
 * tools are many or large, they stay out of the model's tool list; the turn message gets a compact index
 * (renderConnectorIndex) and the model finds a tool (searchConnectorTools), then runs it through one fixed tool whose
 * arguments are checked here first (checkArgs). Unit-tested in tool-search.test.ts.
 */

/** One connector tool as the search sees it. */
export interface SearchEntry {
  /** The model-facing name, `<slug>__<tool>` (connectorToolName). */
  name: string;
  /** The server's own tool name. */
  serverName: string;
  slug: string;
  connectorName: string;
  description: string;
  /** Characters this tool would add to the prompt as a full tool definition (description + schema). */
  chars: number;
}

/** Up to this many tools and this many definition characters (~3k tokens) are offered directly; above either, deferred. */
export const INLINE_MAX_TOOLS = 8;
export const INLINE_MAX_CHARS = 12_000;
/** Tools a search returns in full (with schemas). */
export const SEARCH_RESULTS_MAX = 5;

export interface InlineLimits {
  tools: number;
  chars: number;
}

/** Whether these tools go in the tool list (false) or behind find_connector_tools / use_connector (true). */
export function shouldDefer(entries: readonly Pick<SearchEntry, 'chars'>[], limits: InlineLimits = { tools: INLINE_MAX_TOOLS, chars: INLINE_MAX_CHARS }): boolean {
  if (entries.length > limits.tools) return true;
  return entries.reduce((n, e) => n + e.chars, 0) > limits.chars;
}

/** Lowercase words of a name or text: snake_case, kebab-case, dots and camelCase split; a plural `s` dropped. */
export function searchTerms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** The short form the index lists: the server tool's sanitized name without the `<slug>__` prefix. */
export function shortName(e: Pick<SearchEntry, 'name' | 'slug'>): string {
  const prefix = `${e.slug}__`;
  return e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
}

/**
 * The entry a name refers to: the exact model-facing name, else `<short name>` / the server's own name (within
 * `connector` when given). Null when none or more than one match.
 */
export function resolveEntry<T extends SearchEntry>(entries: readonly T[], raw: string, connector?: string): T | null {
  const name = raw.trim();
  if (!name) return null;
  const exact = entries.find((e) => e.name === name);
  if (exact) return exact;
  const pool = connector ? entries.filter((e) => e.slug === connector) : entries;
  const loose = pool.filter((e) => shortName(e) === name || e.serverName === name);
  return loose.length === 1 ? loose[0]! : null;
}

/**
 * Keyword search: every query term scores 3 when it matches a word of the tool's name (2 for a prefix match) and 1
 * when it is in the description. Best first, ties in list order; only tools with a positive score.
 */
export function searchConnectorTools<T extends SearchEntry>(entries: readonly T[], query: string, o: { connector?: string; limit?: number } = {}): T[] {
  const terms = [...new Set(searchTerms(query))];
  const pool = o.connector ? entries.filter((e) => e.slug === o.connector) : entries;
  if (terms.length === 0) return [];
  const scored = pool.map((e, i) => {
    const nameWords = searchTerms(`${e.serverName} ${e.name}`);
    const desc = new Set(searchTerms(e.description));
    let score = 0;
    for (const t of terms) {
      if (nameWords.includes(t)) score += 3;
      else if (t.length >= 3 && nameWords.some((w) => w.startsWith(t) || (w.length >= 3 && t.startsWith(w)))) score += 2;
      if (desc.has(t)) score += 1;
    }
    return { e, i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, o.limit ?? SEARCH_RESULTS_MAX)
    .map((s) => s.e);
}

const escapeText = (s: string) => s.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));

/**
 * The turn message's `<connectors>` block: one line per connector with its tools' short names. Names are sanitized
 * to `[a-zA-Z0-9_-]` (connectorToolName); connector names are escaped.
 */
export function renderConnectorIndex(entries: readonly SearchEntry[]): string {
  if (entries.length === 0) return '';
  const groups = new Map<string, { name: string; tools: string[] }>();
  for (const e of entries) {
    const g = groups.get(e.slug) ?? { name: e.connectorName, tools: [] };
    g.tools.push(shortName(e));
    groups.set(e.slug, g);
  }
  const lines = [...groups].map(([slug, g]) => `- ${escapeText(g.name)} (\`${slug}\`, ${g.tools.length} tool${g.tools.length === 1 ? '' : 's'}): ${g.tools.join(', ')}`);
  return (
    "<connectors>\nThe speaker's connected services (MCP connectors), acting on their own accounts. These tools aren't loaded: " +
    'to use one, call find_connector_tools (a query, or names from this list) for its exact name and arguments, then ' +
    `use_connector to run it. A tool's full name is \`<connector>__<tool>\`.\n${lines.join('\n')}\n</connectors>`
  );
}

type JsonSchema = Record<string, unknown>;

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return true;
  }
}

/**
 * A shallow check of `args` against a tool's (prepared) input schema: required keys, top-level types and enums, and
 * no unknown keys when the schema forbids them. Nested values are left to the server. Problems, or [] when it passes.
 * With tools in the list, the provider checks the call; behind use_connector this is the only check before the call.
 */
export function checkArgs(schema: JsonSchema, args: Record<string, unknown>, max = 5): string[] {
  const problems: string[] = [];
  const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [];
  for (const k of required) if (args[k] === undefined) problems.push(`missing required argument \`${k}\``);
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const p = props[k];
    if (!p || typeof p !== 'object') {
      if (schema.additionalProperties === false) problems.push(`unknown argument \`${k}\``);
      continue;
    }
    const types = typeof p.type === 'string' ? [p.type] : Array.isArray(p.type) ? p.type.filter((t): t is string => typeof t === 'string') : [];
    if (types.length > 0 && !types.some((t) => typeOk(t, v))) problems.push(`\`${k}\` must be ${types.join(' or ')}`);
    else if (Array.isArray(p.enum) && !p.enum.some((x) => x === v)) problems.push(`\`${k}\` must be one of ${p.enum.slice(0, 10).map((x) => JSON.stringify(x)).join(', ')}`);
  }
  return problems.slice(0, max);
}

/** use_connector's `arguments`: an object, or a JSON object in a string (some models send that). Null otherwise. */
export function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return {};
    try {
      v = JSON.parse(s);
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
