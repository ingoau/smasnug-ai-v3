/**
 * The field a stored login is typed into (browser_fill_credential, vault.ts; pure, fields.test.ts): it must be an
 * input of the page's top document (not inside an iframe, which may be another site) of a type that fits the part
 * of the login. Checked before the approval card (which names the field) and again in the exec that types.
 */
import { shq } from '../provider.js';

export type Field = 'username' | 'password' | 'totp';
/** Input types each part of a login may be typed into. */
export const FIELD_TYPES: Record<Field, string[]> = { username: ['text', 'email', 'tel', 'url', 'search'], password: ['password'], totp: ['text', 'tel', 'number', 'password'] };

/**
 * JS for `agent-browser eval -b`: the focused element of the top document (through open shadow roots, never into a
 * frame: focus inside an iframe leaves the IFRAME element as document.activeElement), as
 * "ABFIELD <TAG> <input type or -> <label, URI-encoded>".
 */
const FIELD_JS = `(() => { let e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; if (!e || e === document.body || e === document.documentElement) return 'ABFIELD NONE - '; const tag = e.tagName; const type = tag === 'INPUT' ? String(e.type || 'text').toLowerCase() : '-'; const lab = (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || e.id || ''; return 'ABFIELD ' + tag + ' ' + type + ' ' + encodeURIComponent(String(lab).trim().slice(0, 80)); })()`;

/** Bash: focus the ref, then print what has focus (one ABFIELD line, or nothing). stdin stays untouched. */
export const fieldProbe = (ref: string) =>
  `timeout 10 agent-browser focus ${shq(ref)} </dev/null >/dev/null 2>&1 && timeout 10 agent-browser eval -b ${shq(Buffer.from(FIELD_JS).toString('base64'))} </dev/null 2>/dev/null | tr -d '"' | grep -o 'ABFIELD [^ ]* [^ ]* [^ ]*' | tail -n 1`;

export interface FieldInfo {
  tag: string;
  type: string;
  label: string;
}

export function parseField(text: string | undefined): FieldInfo | null {
  const m = /ABFIELD (\S+) (\S+) ?(\S*)/.exec(text ?? '');
  if (!m) return null;
  let label = '';
  try {
    label = decodeURIComponent(m[3] ?? '');
  } catch {}
  return { tag: m[1]!, type: m[2]!, label };
}

/** Why a field can't take this part of a login (null: it can). */
export function fieldRefusal(f: FieldInfo | null, field: Field, ref: string): string | null {
  if (!f) return `Couldn't check ${ref} (it may be gone or not focusable); nothing was typed. Look at the page again (browser_read) and retry with the field's ref.`;
  if (f.tag === 'IFRAME' || f.tag === 'FRAME') return `${ref} is inside an embedded frame (content from another page shown inside this one); a login is only typed into the page itself. Nothing was typed.`;
  if (f.tag !== 'INPUT') return `${ref} isn't an input field on the page; nothing was typed. Pick the ${field} field's ref.`;
  if (!FIELD_TYPES[field].includes(f.type)) return field === 'password' ? `${ref} isn't a password field; nothing was typed. Pick the password field.` : `${ref} is a ${f.type} field, not a ${field} field; nothing was typed.`;
  return null;
}
