/**
 * Shared plumbing of the browser tools (docs/sandbox.md §3.9): the kill switch and rate limit, one exec per tool call
 * (cli.ts builds it), the domain check after every action, on the URL before and after the page content was captured
 * (policy.ts; a page that ends up somewhere refused is left for about:blank, and content from a page whose URL
 * couldn't be read isn't shown), the per-action thread event and the text the model gets back (title, URL and a
 * trimmed snapshot, wrapped as untrusted). Output scrubbing happens in tools.ts `run`.
 */
import { appendEvent } from '../../core/events.js';
import type { ToolContext } from '../../core/tools.js';
import { takeLimit } from '../../features/guard.js';
import { vaultConfigured } from '../../features/vault/crypto.js';
import { hostAllowed, listCredentials } from '../../features/vault/store.js';
import { untrusted } from '../../tools/util.js';
import type { ExecResult, Handle } from '../provider.js';
import { sandboxSettings } from '../settings.js';
import { p } from '../tools.js';
import { ab, BROWSER_SCRIPT, newNonce, pageScript, parseSections, shortError, trimSnapshot, type PageScript, type PageSections } from './cli.js';
import { envPolicy, urlVerdict, type Verdict } from './policy.js';

/** Snapshot budgets (characters): after an action, and for browser_read mode=snapshot. */
export const SNAP_ACTION_CHARS = 3_500;
export const SNAP_FULL_CHARS = 14_000;
export const READ_PAGE_CHARS = 16_000;
const DEFAULT_TIMEOUT_S = 90;

/** Role, kill switch and the hourly limit. Returns the model-facing refusal, or null. */
export async function browserRefusal(ctx: ToolContext): Promise<string | null> {
  if (ctx.role !== 'child' || !ctx.subagentId) return 'Browser tools are only available to subagents.';
  if ((await sandboxSettings()).browserDisabled)
    return 'The browser tools are turned off on this bot right now. Use fetch_url / web_search for reading; if the task needs a real browser, say in your result that it is unavailable.';
  return takeLimit('browser_action', ctx.speakerId, ctx.threadId);
}

/** One composite agent-browser command (cli.ts) in the sandbox; stdin and extra env pass through. */
export function abExec(ctx: ToolContext, h: Handle, cmd: string, o: { stdin?: Buffer; timeoutS?: number; maxBytes?: number; env?: Record<string, string> } = {}): Promise<ExecResult> {
  const timeoutS = o.timeoutS ?? DEFAULT_TIMEOUT_S;
  return p().exec(h, ['bash', '-c', BROWSER_SCRIPT], {
    env: { ...o.env, SBX_CMD: cmd, SBX_TIMEOUT: String(timeoutS) },
    timeoutMs: (timeoutS + 20) * 1000,
    maxOutputBytes: o.maxBytes ?? 512 * 1024,
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    ...(o.stdin ? { stdin: o.stdin } : {}),
  });
}

type ExecOpts = { stdin?: Buffer; timeoutS?: number; maxBytes?: number; env?: Record<string, string> };

/** One page script (fresh marker nonce), run and split into its sections. */
export async function execPage(ctx: ToolContext, h: Handle, script: PageScript, o: ExecOpts = {}): Promise<{ r: ExecResult; s: PageSections }> {
  const nonce = newNonce();
  const r = await abExec(ctx, h, pageScript(script, nonce), o);
  return { r, s: parseSections(r.stdout.toString('utf8'), nonce) };
}

/**
 * Where the page is: `v` for the URL after the action; `refused` if that or the URL after the content was captured
 * isn't allowed; `unknown` if there is page content but either URL is missing (then the content isn't shown).
 */
export function checkPage(s: PageSections): { v: Verdict | null; refused: Verdict | null; unknown: boolean } {
  const v = verdictOf(s);
  const after = s.urlAfter ? urlVerdict(s.urlAfter, envPolicy()) : null;
  const refused = v && !v.ok ? v : after && !after.ok ? after : null;
  const content = s.snapshot !== undefined || s.body !== undefined;
  return { v, refused, unknown: content && (!v || !after) };
}

/** Sections without the page content (its URL couldn't be confirmed). */
export const withoutContent = (s: PageSections): PageSections => ({ ...s, snapshot: undefined, body: undefined });
export const UNKNOWN_PAGE = "[The browser didn't report which page it is on, so the page content isn't shown. Try browser_read again.]";

/** Per-action thread event. Never typed text (only its length), never a query string. */
export function logAction(ctx: ToolContext, action: string, v: Verdict | null, extra: Record<string, unknown> = {}): void {
  const where = v ? { host: v.host, path: v.ok ? v.path : null, ...(v.ok ? {} : { blocked: true }) } : { host: null, path: null };
  void appendEvent(ctx.threadId, 'browser_action', `subagent:${ctx.subagentId}`, { runId: ctx.runId ?? null, action, ...where, ...extra }).catch(() => {});
}

/** The page went somewhere refused: leave it. */
export async function leavePage(ctx: ToolContext, h: Handle): Promise<void> {
  await abExec(ctx, h, `${ab('open', 'about:blank')} >/dev/null 2>&1`, { timeoutS: 30 }).catch(() => {});
}

export const leftText = (v: Verdict) => `The page went to ${v.host ?? 'an address that is not allowed'}, which is refused (${v.ok ? '' : v.reason}). I left it (about:blank). Don't try to reach it another way.`;

export function verdictOf(s: PageSections): Verdict | null {
  return s.url ? urlVerdict(s.url, envPolicy()) : null;
}

/** Leave a refused page (and log it); the model-facing text. */
export async function refusePage(ctx: ToolContext, h: Handle, action: string, v: Verdict, extra: Record<string, unknown> = {}): Promise<string> {
  logAction(ctx, action, v, extra);
  await leavePage(ctx, h);
  return leftText(v);
}

/** Title, URL, the trimmed snapshot and/or a body, as untrusted page content, plus a cut note for the model. */
export function formatPage(s: PageSections, o: { status: string; snapChars?: number; error?: string; body?: string; after?: string[] }): string {
  const inner: string[] = [];
  if (o.error) inner.push(`Error: ${o.error}`);
  if (s.title) inner.push(`Title: ${s.title}`);
  if (s.url) inner.push(`URL: ${s.url}`);
  const notes: string[] = [];
  if (s.snapshot !== undefined) {
    const t = trimSnapshot(s.snapshot, o.snapChars ?? SNAP_ACTION_CHARS);
    inner.push(t.text ? `Elements (act on them by @ref):\n${t.text}` : 'No elements found yet (the page may still be loading: browser_act wait for some text).');
    if (t.cut) notes.push(`[${t.cut} more snapshot lines cut: browser_read (snapshot with a CSS selector, or text), or scroll.]`);
  }
  if (o.body !== undefined) inner.push(o.body);
  const parts = [o.status];
  if (inner.length) parts.push(untrusted('browser page', inner.join('\n')));
  parts.push(...notes, ...(o.after ?? []));
  return parts.join('\n');
}

export interface PageCall {
  /** Name for logs and the thread event, e.g. "click". */
  action: string;
  script: PageScript;
  /** Status line on success, e.g. "Clicked @e3." */
  ok: string;
  /** Status line on failure, e.g. "click @e3 failed". */
  failed: string;
  ref?: string;
  /** Thread event extras (never typed text). */
  logExtra?: Record<string, unknown>;
  snapChars?: number;
  timeoutS?: number;
  stdin?: Buffer;
  env?: Record<string, string>;
  /** Lines added after the page (hints). */
  after?: (v: Verdict | null) => Promise<string[]>;
  /** A guard's stdout marker → the message to return instead (the script stopped before acting). */
  guards?: Record<string, string>;
}

/** Run one page call in the sandbox: exec, parse, domain check, log, format. */
export async function pageCall(ctx: ToolContext, h: Handle, c: PageCall): Promise<string> {
  const { r, s: raw } = await execPage(ctx, h, c.script, { ...(c.stdin ? { stdin: c.stdin } : {}), ...(c.env ? { env: c.env } : {}), ...(c.timeoutS ? { timeoutS: c.timeoutS } : {}) });
  if (r.aborted) return 'Stopped: the run was cancelled or timed out.';
  for (const [marker, msg] of Object.entries(c.guards ?? {})) if (raw.pre?.includes(marker)) return msg;
  const { v, refused, unknown } = checkPage(raw);
  const extra = { ...(c.ref ? { ref: c.ref } : {}), ...(raw.rc ? { rc: raw.rc } : {}), ...c.logExtra };
  if (refused) return refusePage(ctx, h, c.action, refused, extra);
  logAction(ctx, c.action, v, extra);
  const s = unknown ? withoutContent(raw) : raw;
  const notes = unknown ? [UNKNOWN_PAGE] : [];
  if (r.timedOut || (!s.complete && s.rc === undefined && c.script.actions?.length))
    return formatPage(s, { status: `${c.failed}: the browser didn't finish in time (the page may be stuck). Try browser_read, or browser_open the page again.`, after: notes });
  const failed = s.rc !== undefined && s.rc !== 0;
  const after = [...notes, ...(c.after ? await c.after(v) : [])];
  if (failed) return formatPage(s, { status: `${c.failed} (error below).`, error: shortError(s.action), snapChars: c.snapChars, after });
  return formatPage(s, { status: c.ok, snapChars: c.snapChars, after });
}

/** Stored logins and saved browser sessions of the owner for a host (names only), as hints after browser_open. */
export async function vaultHints(ownerId: string, host: string | null): Promise<string[]> {
  if (!host || !vaultConfigured()) return [];
  const creds = await listCredentials(ownerId, ['login', 'browser_session']).catch(() => []);
  const match = creds.filter((c) => hostAllowed(host, c.meta.domains));
  const sessions = match.filter((c) => c.kind === 'browser_session').map((c) => `\`${c.name}\``);
  const logins = match.filter((c) => c.kind === 'login').map((c) => `\`${c.name}\``);
  const out: string[] = [];
  if (sessions.length) out.push(`[Saved browser login for this site: ${sessions.join(', ')}. If the page wants a login, browser_load_session it (the owner approves), then browser_open the page again.]`);
  if (logins.length) out.push(`[Stored login for this site: ${logins.join(', ')}. Type it with browser_fill_credential (the owner approves); never ask for or type a password yourself.]`);
  return out;
}
