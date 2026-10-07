/**
 * Preview bundles (docs/sandbox.md §3.6, §5.5), pure: limits, the form scan, banner + noindex injection, and the
 * files deployed next to the user's assets. Runs in the worker (Node), never in a sandbox.
 *
 * The banner is injected into every HTML file here, at bundle time, so it works the same with our fixed Worker in
 * front and with the assets-only fallback; `_headers` carries noindex and `form-action 'none'` for assets-only, the
 * Worker sets them too. Client JS can still remove the banner; that can't be helped.
 */
import { limits } from '../../config.js';
import type { TarEntry } from './tar.js';

export interface BundleFile {
  path: string;
  data: Buffer;
}

export type BundleCheck = { ok: true; files: BundleFile[] } | { ok: false; kind: 'invalid' | 'refused'; reason: string };

/** Files we generate; the user's own versions are dropped. `_redirects` could point visitors anywhere. */
const RESERVED = new Set(['_headers', '_redirects', '_worker.js', '_routes.json', 'wrangler.jsonc', 'wrangler.toml', 'wrangler.json']);

export function normalizeEntries(entries: TarEntry[]): { files: BundleFile[]; error?: string } {
  const files: BundleFile[] = [];
  for (const e of entries) {
    const path = e.path.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path || path === '.') continue;
    if (e.type === 'dir') continue;
    if (e.type === 'other') return { files, error: `"${path.slice(0, 80)}" is a link or special file; previews take regular files only.` };
    if (path.startsWith('/') || path.split('/').some((s) => s === '..' || s === '')) return { files, error: `bad path "${path.slice(0, 80)}"` };
    if (RESERVED.has(path)) continue;
    files.push({ path, data: e.data });
  }
  return { files };
}

/** Pure: preview limits (Cloudflare: ≤ 1,000 static files, ≤ 5 MiB each; ours: ≤ 25 MiB total, an index.html). */
export function checkLimits(files: { path: string; size: number }[]): string | null {
  if (!files.some((f) => f.path === 'index.html')) return 'The directory needs an index.html at its top level.';
  if (files.length > limits.previewMaxFiles) return `Too many files (${files.length}; the limit is ${limits.previewMaxFiles}).`;
  const big = files.find((f) => f.size > limits.previewMaxFileBytes);
  if (big) return `${big.path.slice(0, 80)} is too large (${(big.size / 1048576).toFixed(1)} MiB; the limit is 5 MiB per file).`;
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > limits.previewMaxTotalBytes) return `The site is too large (${(total / 1048576).toFixed(1)} MiB; the limit is 25 MiB).`;
  return null;
}

const HTML_RE = /\.html?$/i;
const SCRIPT_RE = /\.(m?js|cjs|jsx|tsx?|vue|svelte)$/i;

/** Field words that mean credentials or payment data. */
const SENSITIVE = String.raw`(?:pass(?:word|wd|code)?|pwd|cvv2?|cvc2?|csc|card[\s_-]*(?:number|no|num)|cc[\s_-]*(?:num(?:ber)?|no)|credit[\s_-]*card|iban|ssn|social[\s_-]*security|routing[\s_-]*number|sort[\s_-]*code|security[\s_-]*code|pin[\s_-]*code)`;
const FIELD_ATTR_RE = new RegExp(String.raw`\b(?:name|id|placeholder|aria-label|for)\s*=\s*["']?[^"'>]*?\b${SENSITIVE}\b`, 'i');
const PASSWORD_INPUT_RE = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
const AUTOCOMPLETE_RE = /\bautocomplete\s*=\s*["']?[^"'>]*\b(?:cc-[a-z-]+|current-password|new-password|one-time-code)\b/i;
const LABEL_RE = new RegExp(String.raw`<label\b[^>]*>([^<]{0,120})`, 'gi');
const FIELD_TAG_RE = /<(?:input|textarea|select)\b[^>]*>/gi;
const JS_TYPE_PASSWORD_RE = /\btype\s*[:=]\s*["'`]password["'`]/i;
const JS_FIELD_RE = new RegExp(String.raw`\b(?:name|id|placeholder|autocomplete|label)\s*[:=]\s*["'\`][^"'\`]*?\b${SENSITIVE}\b`, 'i');
const JS_AUTOCOMPLETE_RE = /["'`](?:cc-(?:number|csc|exp(?:-month|-year)?|name)|current-password|new-password)["'`]/i;
const SENSITIVE_WORD_RE = new RegExp(String.raw`\b${SENSITIVE}\b`, 'i');

/** Pure: the first sign of a login / password / payment form, or null. Plain prose mentioning "password" passes. */
export function scanForms(files: BundleFile[]): string | null {
  for (const f of files) {
    const isHtml = HTML_RE.test(f.path);
    const isScript = SCRIPT_RE.test(f.path);
    if (!isHtml && !isScript) continue;
    const text = f.data.toString('utf8');
    if (isHtml) {
      if (PASSWORD_INPUT_RE.test(text)) return `${f.path}: a password field`;
      if (AUTOCOMPLETE_RE.test(text)) return `${f.path}: a credential or card autocomplete field`;
      for (const tag of text.match(FIELD_TAG_RE) ?? []) if (FIELD_ATTR_RE.test(tag)) return `${f.path}: a credential or payment field`;
      for (const m of text.matchAll(LABEL_RE)) if (SENSITIVE_WORD_RE.test(m[1] ?? '')) return `${f.path}: a credential or payment field label`;
    }
    // Scripts, and inline scripts in HTML.
    const scripts = isScript ? [text] : [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? '');
    for (const s of scripts) {
      if (JS_TYPE_PASSWORD_RE.test(s)) return `${f.path}: a script that creates a password field`;
      if (JS_AUTOCOMPLETE_RE.test(s)) return `${f.path}: a script with credential or card autocomplete fields`;
      if (JS_FIELD_RE.test(s)) return `${f.path}: a script with credential or payment fields`;
      if (/<input\b[^>]*\btype\s*=\s*\\?["']?password/i.test(s)) return `${f.path}: a script that writes a password field`;
    }
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function bannerHtml(o: { requester: string; expiresAt: Date; botName: string }): string {
  const hhmm = o.expiresAt.toISOString().slice(11, 16);
  return (
    `<div id="smasnug-preview-banner" role="note" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;` +
    `background:#1f2328;color:#fff;font:13px/1.4 system-ui,-apple-system,sans-serif;padding:6px 12px;text-align:center;` +
    `box-shadow:0 1px 4px rgba(0,0,0,.3)">Preview built by ${esc(o.botName)} for ${esc(o.requester)} · expires ${hhmm} UTC · ` +
    `not affiliated with any site it imitates</div><div style="height:32px" aria-hidden="true"></div>`
  );
}

/** Pure: banner after <body …> (or at the very start) and a robots meta tag in <head>. */
export function injectBanner(html: string, banner: string): string {
  const meta = '<meta name="robots" content="noindex, nofollow">';
  let out = html;
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => `${m}${meta}`);
  else out = `${meta}${out}`;
  if (/<body\b[^>]*>/i.test(out)) return out.replace(/<body\b[^>]*>/i, (m) => `${m}${banner}`);
  return `${banner}${out}`;
}

export const HEADERS_FILE = `/*
  X-Robots-Tag: noindex, nofollow
  Content-Security-Policy: form-action 'none'
  Referrer-Policy: no-referrer
`;

/**
 * Pure: from the user's tar entries to what gets deployed: limits, the form scan, banners, our `_headers`.
 */
export function prepareBundle(entries: TarEntry[], o: { requester: string; expiresAt: Date; botName: string }): BundleCheck {
  const { files, error } = normalizeEntries(entries);
  if (error) return { ok: false, kind: 'invalid', reason: error };
  const limitErr = checkLimits(files.map((f) => ({ path: f.path, size: f.data.length })));
  if (limitErr) return { ok: false, kind: 'invalid', reason: limitErr };
  const form = scanForms(files);
  if (form) return { ok: false, kind: 'refused', reason: form };
  const banner = bannerHtml(o);
  const out = files.map((f) => (HTML_RE.test(f.path) ? { path: f.path, data: Buffer.from(injectBanner(f.data.toString('utf8'), banner), 'utf8') } : f));
  out.push({ path: '_headers', data: Buffer.from(HEADERS_FILE, 'utf8') });
  return { ok: true, files: out };
}

/** The Worker in front of the assets: security headers on every response, nothing else (no user code runs). */
export const WORKER_SCRIPT = `export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Content-Security-Policy', "form-action 'none'");
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
`;

export function wranglerConfig(o: { name: string; withWorker: boolean }): string {
  const cfg: Record<string, unknown> = {
    name: o.name,
    compatibility_date: '2026-10-01',
    workers_dev: true,
    assets: o.withWorker ? { directory: './site', binding: 'ASSETS', run_worker_first: true } : { directory: './site' },
  };
  if (o.withWorker) cfg.main = './worker.js';
  return JSON.stringify(cfg, null, 2);
}
