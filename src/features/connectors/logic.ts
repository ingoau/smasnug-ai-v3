/**
 * MCP connectors (docs/mcp-custom-connectors.md): the pure parts. Catalog parsing, tool classification, permission
 * mode resolution, tool-name sanitizing, egress origin checks, the OAuth paste blob and the verifier's answer.
 * Unit-tested in logic.test.ts.
 */
import { z } from 'zod';
import type { StoredMessage } from '../../core/types.js';
import { checkUrl } from '../../tools/safe-fetch.js';

export type ToolClass = 'read' | 'write' | 'delete';
export type Mode = 'always_block' | 'always_allow' | 'auto' | 'prompt';
export const MODES: readonly Mode[] = ['always_allow', 'auto', 'prompt', 'always_block'];
export const TOOL_CLASSES: readonly ToolClass[] = ['read', 'write', 'delete'];

export const MODE_LABELS: Record<Mode, string> = {
  always_allow: 'Always allow',
  auto: 'Auto-check',
  prompt: 'Ask me',
  always_block: 'Never',
};
export const CLASS_LABELS: Record<ToolClass, string> = { read: 'Reading', write: 'Changing', delete: 'Deleting' };

export type ConnectorAuth = { type: 'api_key'; header?: string; scheme?: string; help?: string } | { type: 'oauth'; scopes?: string[] };

export interface ConnectorDef {
  slug: string;
  name: string;
  description: string;
  /** Remote Streamable HTTP endpoint (https). */
  url: string;
  auth: ConnectorAuth;
  /** Class overrides by server tool name (the server's own annotations otherwise). */
  tools?: Record<string, ToolClass>;
  /** At most this many of the server's tools are offered (default: all of them, up to CONNECTOR_TOOLS_MAX). */
  maxTools?: number;
}

export interface ConnectorSettings {
  read: Mode;
  write: Mode;
  delete: Mode;
  /** Per server tool name. */
  overrides: Record<string, Mode>;
}

export const DEFAULT_SETTINGS: ConnectorSettings = { read: 'auto', write: 'prompt', delete: 'always_block', overrides: {} };

/**
 * Every tool a server lists is offered (a definition's `maxTools` may limit it). More than a few are deferred behind
 * tool search (tool-search.ts), so these are only safety ceilings against a server listing absurdly many: tools kept
 * from one listing (and cached), and tools offered in one turn.
 */
export const CONNECTOR_TOOLS_MAX = 500;
export const TURN_CONNECTOR_TOOLS_MAX = 500;
/** Longest tool name the model APIs accept. */
export const TOOL_NAME_MAX = 64;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const modeSchema = z.enum(['always_block', 'always_allow', 'auto', 'prompt']);
const classSchema = z.enum(['read', 'write', 'delete']);

const defSchema = z.object({
  slug: z.string().max(24).regex(SLUG_RE, 'slug: lowercase letters, digits and single dashes (max 24)'),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  url: z.string().max(500),
  auth: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('api_key'),
      header: z.string().regex(/^[A-Za-z0-9-]{1,60}$/).optional(),
      scheme: z.string().regex(/^\S{0,30}$/).optional(),
      help: z.string().max(500).optional(),
    }),
    z.object({
      type: z.literal('oauth'),
      scopes: z.union([z.array(z.string().regex(/^\S{1,200}$/)).max(30), z.string().max(2000)]).optional(),
    }),
  ]),
  tools: z.record(z.string().min(1).max(200), classSchema).optional(),
  maxTools: z.number().int().min(1).max(CONNECTOR_TOOLS_MAX).optional(),
});

/** A remote MCP endpoint we may connect to: https, no credentials or fragment, not a private/local address. */
export function validServerUrl(raw: string): string | null {
  try {
    const u = checkUrl(raw);
    if (u.protocol !== 'https:' || u.hash) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * The CONNECTORS_FILE contents (already JSON-parsed) → valid definitions plus one error line per rejected entry.
 * One bad entry never hides the others; duplicate slugs keep the first.
 */
export function parseCatalog(raw: unknown): { defs: ConnectorDef[]; errors: string[] } {
  const errors: string[] = [];
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as any).connectors) ? (raw as any).connectors : null;
  if (!list) return { defs: [], errors: ['The file must be a JSON array of connector definitions.'] };
  const defs: ConnectorDef[] = [];
  const seen = new Set<string>();
  list.forEach((entry: unknown, i: number) => {
    const label = `#${i + 1}${entry && typeof entry === 'object' && typeof (entry as any).slug === 'string' ? ` (${String((entry as any).slug).slice(0, 30)})` : ''}`;
    const r = defSchema.safeParse(entry);
    if (!r.success) {
      const issue = r.error.issues[0];
      errors.push(`${label}: ${issue ? `${issue.path.join('.') || 'entry'}: ${issue.message}` : 'invalid'}`);
      return;
    }
    const d = r.data;
    const url = validServerUrl(d.url);
    if (!url) return void errors.push(`${label}: url must be a public https URL`);
    if (seen.has(d.slug)) return void errors.push(`${label}: duplicate slug`);
    seen.add(d.slug);
    const auth: ConnectorAuth =
      d.auth.type === 'api_key'
        ? { type: 'api_key', ...(d.auth.header ? { header: d.auth.header.toLowerCase() } : {}), ...(d.auth.scheme !== undefined ? { scheme: d.auth.scheme } : {}), ...(d.auth.help ? { help: d.auth.help } : {}) }
        : { type: 'oauth', ...(d.auth.scopes ? { scopes: typeof d.auth.scopes === 'string' ? d.auth.scopes.split(/\s+/).filter(Boolean) : d.auth.scopes } : {}) };
    defs.push({ slug: d.slug, name: d.name, description: d.description, url, auth, ...(d.tools ? { tools: d.tools } : {}), ...(d.maxTools ? { maxTools: d.maxTools } : {}) });
  });
  return { defs, errors };
}

/** Catalog override, else the server's annotations: readOnlyHint → read, destructiveHint → delete, else write. */
export function classifyTool(def: Pick<ConnectorDef, 'tools'>, tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null }): ToolClass {
  const override = def.tools?.[tool.name];
  if (override) return override;
  if (tool.annotations?.readOnlyHint === true) return 'read';
  if (tool.annotations?.destructiveHint === true) return 'delete';
  return 'write';
}

/** A per-action override wins; else the knob for the tool's class. */
export function resolveMode(settings: ConnectorSettings, toolName: string, cls: ToolClass): Mode {
  const o = settings.overrides[toolName];
  return o && (MODES as string[]).includes(o) ? o : settings[cls];
}

export function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (MODES as string[]).includes(v);
}

/** Settings row (or nothing) → complete settings with defaults; unknown modes fall back to the default. */
export function normalizeSettings(row: Partial<{ readMode: string; writeMode: string; deleteMode: string; overrides: unknown }> | null | undefined): ConnectorSettings {
  // Stored as [[tool, mode], …]: the db's camelCase transform rewrites JSON object keys (get_note → getNote).
  const overrides: Record<string, Mode> = {};
  const raw = row?.overrides;
  const pairs = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>) : [];
  for (const p of pairs) if (Array.isArray(p) && typeof p[0] === 'string' && isMode(p[1])) overrides[p[0]] = p[1];
  return {
    read: isMode(row?.readMode) ? row.readMode : DEFAULT_SETTINGS.read,
    write: isMode(row?.writeMode) ? row.writeMode : DEFAULT_SETTINGS.write,
    delete: isMode(row?.deleteMode) ? row.deleteMode : DEFAULT_SETTINGS.delete,
    overrides,
  };
}

/**
 * `<slug>__<tool>` limited to [a-zA-Z0-9_-] and TOOL_NAME_MAX characters, never one of `taken` (adds `_2`, `_3`…).
 * Adds the result to `taken`.
 */
export function connectorToolName(slug: string, tool: string, taken: Set<string>): string {
  const base = `${slug}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, TOOL_NAME_MAX);
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    const suffix = `_${i}`;
    name = `${base.slice(0, TOOL_NAME_MAX - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
}

/** Connector credential name in the vault. */
export const connectionName = (slug: string) => `mcp.${slug}`;

export interface EgressPolicy {
  /** The definition URL's origin: always allowed. */
  mcpOrigin: string;
  /** OAuth origins (authorization server, token endpoint) recorded while connecting: allowed for refreshes. */
  authOrigins: ReadonlySet<string>;
  /** Connecting (OAuth discovery / registration / token exchange): any public https origin, recorded in `seen`. */
  discovering?: boolean;
  seen?: Set<string>;
}

/** Whether a connector's HTTP client may send this request (origin pinning). */
export function egressAllowed(raw: string | URL, policy: EgressPolicy): boolean {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.origin === policy.mcpOrigin) return true;
  if (url.protocol !== 'https:') return false;
  if (policy.authOrigins.has(url.origin)) return true;
  if (!policy.discovering) return false;
  try {
    checkUrl(url.toString());
  } catch {
    return false;
  }
  policy.seen?.add(url.origin);
  return true;
}

/**
 * The string the OAuth callback page (oauth/index.html) shows: `<state>.<code>`. State is base64url (no dots), so the
 * first dot splits; the code may contain dots. Whitespace and surrounding quotes from copying are ignored.
 */
export function parseOAuthBlob(raw: string): { state: string; code: string } | null {
  const s = raw.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
  const i = s.indexOf('.');
  if (i <= 0 || i === s.length - 1) return null;
  const state = s.slice(0, i);
  const code = s.slice(i + 1);
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(state) || code.length > 4000) return null;
  return { state, code };
}

/**
 * The auto-mode verifier's transcript: one JSON object per message, so a message's text (newlines and all, escaped by
 * JSON.stringify) can never pass for another line or another author. Authorship comes from Slack's user / bot ids only:
 * `owner` is true only for the connection owner's own (non-bot) messages, and `trigger` marks the messages of the turn
 * being answered (the owner's latest request). Forwarded content and link previews go in `shared`, files are counted.
 */
export function renderForVerifier(
  msgs: Pick<StoredMessage, 'ts' | 'userId' | 'botId' | 'username' | 'text' | 'files' | 'attachments'>[],
  o: { ownerId: string; botUserId: string; botId?: string | null; botName: string; triggerTs?: readonly string[] },
): string {
  const trigger = new Set(o.triggerTs ?? []);
  return msgs
    .map((m, i) => {
      const own = m.userId === o.botUserId || (o.botId ? m.botId === o.botId : !!m.botId && !m.userId);
      const isBot = own || Boolean(m.botId);
      const from = own ? `${o.botName} (bot)` : m.botId ? `${m.username ?? m.userId ?? 'app'} (bot)` : `<@${m.userId ?? 'unknown'}>`;
      let text = (m.text ?? '').replaceAll(`<@${o.botUserId}>`, `@${o.botName}`);
      if (text.length > 1200) text = `${text.slice(0, 1200)}…`;
      const shared = (m.attachments ?? [])
        .filter((a) => a.text && !m.text.includes(a.text))
        .map((a) => ({ kind: a.kind === 'link' ? 'link preview' : a.kind, text: a.text!.length > 300 ? `${a.text!.slice(0, 300)}…` : a.text }));
      return JSON.stringify({
        n: i + 1,
        from,
        owner: !isBot && m.userId === o.ownerId,
        ...(trigger.has(m.ts) ? { trigger: true } : {}),
        text,
        ...(shared.length ? { shared } : {}),
        ...(m.files?.length ? { files: m.files.length } : {}),
      });
    })
    .join('\n');
}

/** The chat-model verifier's answer: approves only on a leading YES (anything else, including nothing, refuses). */
export function parseVerifierAnswer(text: string | null | undefined): boolean {
  const first = (text ?? '').trim().toLowerCase().replace(/^[^a-z]+/, '');
  return /^yes\b/.test(first);
}

/** Decisions API answer: approve only for a finite probability at or above the threshold. */
export function decisionApproves(p: unknown, threshold: number): boolean {
  const n = typeof p === 'number' ? p : typeof p === 'string' && p.trim() ? Number(p) : NaN;
  return Number.isFinite(n) && n >= threshold;
}

/**
 * Top-level keywords the model APIs refuse in a tool's input schema (Anthropic rejects anyOf / oneOf / allOf at the top
 * level; not and if/then/else are no better). They are dropped and described in the tool description instead.
 */
const TOP_LEVEL_UNSUPPORTED = ['anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else'] as const;
/** Top-level keywords that only identify the document; dropped. */
const TOP_LEVEL_DROPPED = ['$schema', '$id', '$comment'] as const;

export interface PreparedSchema {
  /** Always an object schema the model APIs accept. */
  schema: Record<string, unknown>;
  /** Argument rules that couldn't stay in `schema` (untrusted server text, trimmed), for the tool description. */
  argsNote?: string;
}

function jsonText(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** A top-level `$ref` into the schema's own `$defs` / `definitions` (one level), else null. */
function resolveTopRef(s: Record<string, unknown>): Record<string, unknown> | null {
  const ref = s.$ref;
  if (typeof ref !== 'string') return null;
  const m = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  const defs = m ? (s[m[1]!] as Record<string, unknown> | undefined) : undefined;
  const target = m && defs && typeof defs === 'object' ? defs[m[2]!] : undefined;
  if (!target || typeof target !== 'object' || Array.isArray(target) || '$ref' in (target as object)) return null;
  const { $ref: _ref, ...rest } = s;
  return { ...rest, ...(target as Record<string, unknown>) };
}

/**
 * A tool's input schema as the model APIs need it: an object schema without top-level combinators, not too big.
 * Whatever can't stay (combinators, a non-object or oversized schema, an unresolvable top-level $ref) becomes a
 * permissive object schema plus `argsNote` describing the expected arguments.
 */
export function prepareInputSchema(schema: unknown, o: { maxChars?: number; noteMax?: number } = {}): PreparedSchema {
  const maxChars = o.maxChars ?? 12_000;
  const noteMax = o.noteMax ?? 1500;
  const permissive = { type: 'object', properties: {}, additionalProperties: true };
  const note = (label: string, v: unknown): string | undefined => {
    const t = jsonText(v);
    if (!t || t === '{}') return undefined;
    return `${label}: ${t.length > noteMax ? `${t.slice(0, noteMax - 1)}…` : t}`;
  };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { schema: permissive };
  const json = jsonText(schema);
  if (json === null) return { schema: permissive };
  let s = JSON.parse(json) as Record<string, unknown>;
  for (const k of TOP_LEVEL_DROPPED) delete s[k];
  if (s.$ref !== undefined) {
    const resolved = resolveTopRef(s);
    if (!resolved) return { schema: permissive, argsNote: note('Expected arguments (JSON schema, not enforced)', s) };
    s = resolved;
    for (const k of TOP_LEVEL_DROPPED) delete s[k];
  }
  if (json.length > maxChars || (s.type !== undefined && s.type !== 'object')) {
    return { schema: permissive, argsNote: note('Expected arguments (JSON schema, not enforced)', s) };
  }
  const dropped: Record<string, unknown> = {};
  for (const k of TOP_LEVEL_UNSUPPORTED) {
    if (k in s) {
      dropped[k] = s[k];
      delete s[k];
    }
  }
  const properties = s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties) ? s.properties : {};
  if (Object.keys(dropped).length > 0) {
    return { schema: { ...s, type: 'object', properties, additionalProperties: true }, argsNote: note('Argument rules (JSON schema, not enforced)', dropped) };
  }
  return { schema: { ...s, type: 'object', properties } };
}

/** prepareInputSchema's schema alone. */
export function sanitizeInputSchema(schema: unknown, maxChars = 12_000): Record<string, unknown> {
  return prepareInputSchema(schema, { maxChars }).schema;
}

/** Untrusted server text for a description: one line-ish, no control characters, capped. */
export function cleanDescription(raw: string | undefined, max = 600): string {
  const s = (raw ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface McpContentItem {
  type?: string;
  text?: unknown;
  resource?: { uri?: unknown; text?: unknown; mimeType?: unknown } | null;
  uri?: unknown;
  name?: unknown;
}

/**
 * An MCP tools/call result → plain text for the model: text items and text resources only (images, audio and binary
 * resources are counted, not shown), structuredContent when there is no text, capped at `maxChars`.
 */
export function renderToolResult(result: { content?: McpContentItem[] | unknown; structuredContent?: unknown; isError?: unknown; toolResult?: unknown } | null | undefined, maxChars = 20_000): { text: string; isError: boolean } {
  const parts: string[] = [];
  let skipped = 0;
  const content = Array.isArray(result?.content) ? (result!.content as McpContentItem[]) : [];
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type === 'resource' && c.resource && typeof c.resource.text === 'string') parts.push(`[resource ${String(c.resource.uri ?? '').slice(0, 200)}]\n${c.resource.text}`);
    else if (c?.type === 'resource_link' && typeof c.uri === 'string') parts.push(`[link: ${String(c.name ?? '').slice(0, 100)} ${c.uri.slice(0, 500)}]`);
    else skipped++;
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 1));
    } catch {
      /* not serialisable */
    }
  }
  if (parts.length === 0 && result?.toolResult !== undefined) {
    try {
      parts.push(JSON.stringify(result.toolResult));
    } catch {
      /* not serialisable */
    }
  }
  let text = parts.join('\n\n');
  if (skipped) text += `${text ? '\n\n' : ''}[${skipped} non-text item(s) omitted]`;
  if (!text) text = '(empty result)';
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[cut at ${maxChars} characters]`;
  return { text, isError: result?.isError === true };
}
