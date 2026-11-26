/**
 * agent-browser state files (`state save` / `state load`; cookies + localStorage, Playwright's storageState shape:
 * `{ cookies: [{ name, value, domain, path, … }], origins: [{ origin, localStorage: [{ name, value }] }] }`).
 * Pure helpers for saved browser sessions (state.test.ts): which sites a state logs into, and keeping only one site's
 * part of it. Unknown fields are kept as they are.
 */
import { hostAllowed } from '../../features/vault/store.js';

export interface StateCookie {
  name?: string;
  value?: string;
  domain?: string;
  [k: string]: unknown;
}

export interface StateOrigin {
  origin?: string;
  [k: string]: unknown;
}

export interface BrowserState {
  cookies?: StateCookie[];
  origins?: StateOrigin[];
  [k: string]: unknown;
}

export function parseState(text: string): BrowserState | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const s = v as BrowserState;
    if (s.cookies !== undefined && !Array.isArray(s.cookies)) return null;
    if (s.origins !== undefined && !Array.isArray(s.origins)) return null;
    return s;
  } catch {
    return null;
  }
}

const cookieHost = (c: StateCookie) => (typeof c.domain === 'string' ? c.domain.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '') : '');

function originHost(o: StateOrigin): string {
  try {
    const u = new URL(String(o.origin ?? ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** The sites a state holds cookies / storage for, without the ones covered by a parent in the list. */
export function stateDomains(s: BrowserState): string[] {
  const all = new Set<string>();
  for (const c of s.cookies ?? []) if (cookieHost(c).includes('.')) all.add(cookieHost(c));
  for (const o of s.origins ?? []) if (originHost(o).includes('.')) all.add(originHost(o));
  const list = [...all];
  return list.filter((d) => !list.some((p) => p !== d && d.endsWith(`.${p}`))).sort();
}

/**
 * Only what belongs to `domains`: cookies for those hosts or their subdomains, plus parent-domain cookies those hosts
 * receive (".example.com" for app.example.com); storage of matching origins.
 */
export function filterState(s: BrowserState, domains: string[]): BrowserState {
  const keepCookie = (c: StateCookie) => {
    const h = cookieHost(c);
    if (!h) return false;
    return hostAllowed(h, domains) || domains.some((d) => d === h || d.endsWith(`.${h}`));
  };
  return {
    ...s,
    cookies: (s.cookies ?? []).filter(keepCookie),
    origins: (s.origins ?? []).filter((o) => {
      const h = originHost(o);
      return !!h && hostAllowed(h, domains);
    }),
  };
}

export function stateCounts(s: BrowserState): { cookies: number; origins: number } {
  return { cookies: s.cookies?.length ?? 0, origins: s.origins?.length ?? 0 };
}
