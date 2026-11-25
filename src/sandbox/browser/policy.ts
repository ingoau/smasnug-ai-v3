/**
 * Where the browser tools may go (docs/sandbox.md §3.9). Pure: unit-tested in policy.test.ts.
 * - http(s): checkUrl (no private / local addresses, no credentials in the URL), then the admin's lists from env
 *   (BROWSER_DENY_DOMAINS, BROWSER_ALLOW_DOMAINS; subdomains included).
 * - file:// only under /work (the agent's own files, e.g. a page it built); about:blank and Chromium's error page.
 * - Anything else (data:, javascript:, chrome:, view-source:…) is refused.
 * Checked before browser_open and after every action (a click or a script can navigate anywhere).
 */
import { env } from '../../config.js';
import { hostAllowed, parseDomains } from '../../features/vault/store.js';
import { checkUrl } from '../../tools/safe-fetch.js';
import { workPath } from '../provider.js';

export interface DomainPolicy {
  deny: string[];
  /** Empty = any public site (minus deny). */
  allow: string[];
}

export type Verdict =
  /** host is null for pages without a network origin (about:blank, a /work file). path never has the query. */
  | { ok: true; host: string | null; path: string | null; https: boolean }
  | { ok: false; reason: string; host: string | null };

export function envPolicy(): DomainPolicy {
  return { deny: parseDomains(env.BROWSER_DENY_DOMAINS), allow: parseDomains(env.BROWSER_ALLOW_DOMAINS) };
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_SCHEMES = /^(about|data|javascript|file|chrome|view-source|blob):/i;

/** What the model typed → a URL: "example.com/x" → "https://example.com/x"; anything with a scheme stays. */
export function normalizeOpenUrl(raw: string): string {
  const s = raw.trim();
  if (SCHEME_RE.test(s) || BARE_SCHEMES.test(s)) return s;
  return `https://${s.replace(/^\/+/, '')}`;
}

export function urlVerdict(raw: string, policy: DomainPolicy): Verdict {
  const s = (raw ?? '').trim();
  if (!s || /^about:(blank|srcdoc)$/i.test(s) || /^chrome-error:\/\//i.test(s)) return { ok: true, host: null, path: null, https: false };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: `"${s.slice(0, 100)}" isn't a valid URL`, host: null };
  }
  if (u.protocol === 'file:') {
    let p: string | null = null;
    try {
      p = u.host ? null : workPath(decodeURIComponent(u.pathname));
    } catch {
      p = null;
    }
    return p ? { ok: true, host: null, path: p, https: false } : { ok: false, reason: 'only files under /work can be opened (file:///work/…)', host: null };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `${u.protocol} URLs can't be opened`, host: null };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  try {
    checkUrl(u.toString());
  } catch (err) {
    return { ok: false, reason: (err as Error).message, host };
  }
  if (hostAllowed(host, policy.deny)) return { ok: false, reason: `${host} is blocked for the browser on this bot`, host };
  if (policy.allow.length && !hostAllowed(host, policy.allow)) return { ok: false, reason: `only these sites may be opened on this bot: ${policy.allow.join(', ')}`, host };
  return { ok: true, host, path: u.pathname.slice(0, 300), https: u.protocol === 'https:' };
}

/** `https://host[:port]` of a page, for pinning a credential fill to the page that was approved. Null for non-http. */
export function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}
