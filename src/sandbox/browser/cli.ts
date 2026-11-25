/**
 * agent-browser@0.43.0 command lines and output parsing for the browser tools (pure; cli.test.ts). Each tool call is
 * one exec: the action, a short settle, then `get url` / `get title` (for the domain check and the header) and
 * usually a snapshot, each section behind a marker line so one round trip gives the model the new state.
 *
 * Verified against the 0.43.0 package docs (skill-data/core): `snapshot -i` (interactive elements, refs `@eN`),
 * `-c` (compact), `-s <css>` (scope); `fill <ref> -- <text>` (text after `--` is literal); `press <key>`;
 * `select <ref> <value>`; `scroll <dir> <px>`; `scrollintoview <ref>`; `wait <ref> | --text | --url`;
 * `wait --load domcontentloaded`; `read` (rendered text of the active tab); `get url|title|text|attr`;
 * `screenshot [--full] [--annotate] <path>`; `back`; `close`; `state save|load <file>`.
 */
import { shq } from '../provider.js';

export const AB = 'agent-browser';

/** The exec wrapper: the composite command and its timeout come in env (SBX_CMD, SBX_TIMEOUT); stdin passes through. */
export const BROWSER_SCRIPT = 'timeout --kill-after=5 "${SBX_TIMEOUT}s" bash -c "$SBX_CMD"';

/** "@e12", "e12", "[ref=e12]", "ref=e12" → "@e12"; anything else → null. */
export function normRef(raw: string): string | null {
  const m = /^\s*(?:\[?ref=)?@?(e\d{1,6})\]?\s*$/i.exec(raw ?? '');
  return m ? `@${m[1]!.toLowerCase()}` : null;
}

/** A key for `press`: "Enter", "Tab", "ArrowDown", "Control+a", "Shift+Tab", "a", "/". Not text to type. */
export function validKey(raw: string): boolean {
  return /^(?:(?:Control|Ctrl|Shift|Alt|Meta|Cmd|Command)\+){0,3}(?:[A-Za-z][A-Za-z0-9]{0,19}|[0-9]|[!-/:-@[-`{-~])$/.test((raw ?? '').trim());
}

/**
 * An argument that stands for the value read from stdin into $SBX_VALUE (a vault secret: never in argv of the exec,
 * never in env). Only the credential fill uses it.
 */
export const STDIN_VALUE = '\u0000stdin-value\u0000';

/** `agent-browser arg…`, every argument quoted for bash (STDIN_VALUE → "$SBX_VALUE"). */
export function ab(...args: string[]): string {
  return [AB, ...args.map((a) => (a === STDIN_VALUE ? '"$SBX_VALUE"' : shq(a)))].join(' ');
}

const mark = (name: string) => `printf '\\n@@ab:${name}@@\\n'`;

/** interactive: elements with refs only (`-i -c`); all: page text too (`-c`); none. */
export type SnapshotMode = 'interactive' | 'all' | 'none';

export interface PageScript {
  /** The action: one or more agent-browser argument lists, run in order, stopping at the first failure. */
  actions?: string[][] | null;
  /** Wait briefly for DOMContentLoaded after the action (clicks, presses, navigation). */
  settle?: boolean;
  /** Read the page's URL and title afterwards (default true; false for `close`, which must not relaunch it). */
  look?: boolean;
  snapshot?: SnapshotMode;
  /** Extra snapshot flags, e.g. ['-s', '#main']. */
  snapshotArgs?: string[];
  /** agent-browser arguments whose output is the body (e.g. ['read'] or ['get', 'text', '@e3']). */
  body?: string[] | null;
  /** A bash line run first; it must `exit` non-zero itself to stop the script (e.g. an origin check). */
  guard?: string;
}

/** The composite bash command for one browser tool call. Sections: action + rc, url, title, snapshot, body. */
export function pageScript(o: PageScript): string {
  const lines: string[] = [];
  if (o.guard) lines.push(o.guard);
  if (o.actions?.length) {
    const chain = o.actions.map((a) => ab(...a)).join(' && ');
    lines.push(`${mark('action')}; { ${chain}; } 2>&1; printf '\\n@@ab:rc=%s@@\\n' "$?"`);
    if (o.settle) lines.push(`timeout 8 ${ab('wait', '--load', 'domcontentloaded')} >/dev/null 2>&1`);
  }
  if (o.look !== false) {
    lines.push(`${mark('url')}; timeout 15 ${ab('get', 'url')} 2>/dev/null`);
    lines.push(`${mark('title')}; timeout 15 ${ab('get', 'title')} 2>/dev/null`);
  }
  if (o.snapshot && o.snapshot !== 'none') {
    const flags = ['snapshot', ...(o.snapshot === 'interactive' ? ['-i', '-c'] : ['-c']), ...(o.snapshotArgs ?? [])];
    lines.push(`${mark('snapshot')}; timeout 30 ${ab(...flags)} 2>&1`);
  }
  if (o.body) lines.push(`${mark('body')}; timeout 60 ${ab(...o.body)} 2>&1`);
  lines.push(`${mark('end')}`);
  return lines.join('\n');
}

export interface PageSections {
  /** Output of the action (its errors, mostly). */
  action?: string;
  rc?: number;
  url?: string;
  title?: string;
  snapshot?: string;
  body?: string;
  /** Output before the first marker (a guard's message). */
  pre?: string;
  /** The script reached its end (false: it was killed or a guard stopped it). */
  complete: boolean;
}

/** Split the composite script's stdout into its sections. */
export function parseSections(stdout: string): PageSections {
  const out: PageSections = { complete: false };
  const re = /\n@@ab:(\w+)(?:=(-?\d+))?@@\n/g;
  let last: { name: string; start: number } | null = null;
  const put = (name: string, text: string) => {
    if (name === 'action' || name === 'snapshot' || name === 'body') out[name] = text.replace(/\n+$/, '');
    else if (name === 'url') out.url = firstUrl(text) ?? undefined;
    else if (name === 'title') out.title = text.trim().split('\n').filter(Boolean).pop()?.slice(0, 300);
  };
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = re.exec(stdout))) {
    if (first) {
      const pre = stdout.slice(0, m.index).trim();
      if (pre) out.pre = pre;
      first = false;
    }
    if (last) put(last.name, stdout.slice(last.start, m.index));
    const name = m[1]!;
    if (name === 'rc') {
      out.rc = Number(m[2]);
      last = null;
      continue;
    }
    if (name === 'end') {
      out.complete = true;
      last = null;
      continue;
    }
    last = { name, start: m.index + m[0].length };
  }
  if (first) {
    const pre = stdout.trim();
    if (pre) out.pre = pre;
  }
  if (last) put(last.name, stdout.slice(last.start));
  return out;
}

/** The URL `get url` printed (its last line that looks like one). */
export function firstUrl(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(l));
  return lines.pop() ?? null;
}

/**
 * A snapshot the model can afford: no blank lines, long lines cut, at most `maxChars` (whole lines), with a note
 * saying how many lines were left out and how to see them.
 */
export function trimSnapshot(text: string, maxChars: number, lineMax = 240): { text: string; cut: number } {
  const lines = (text ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  const out: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i]!.length > lineMax ? `${lines[i]!.slice(0, lineMax)}…` : lines[i]!;
    if (used + l.length + 1 > maxChars && out.length) break;
    out.push(l);
    used += l.length + 1;
  }
  return { text: out.join('\n'), cut: lines.length - i };
}

/** One page of a long text, with the offset to continue from (null at the end). */
export function pageOf(text: string, offset: number, size: number): { text: string; from: number; to: number; total: number; next: number | null } {
  const from = Math.min(Math.max(0, offset), text.length);
  const to = Math.min(text.length, from + size);
  return { text: text.slice(from, to), from, to, total: text.length, next: to < text.length ? to : null };
}

/** An action's error output, short (agent-browser prints "✗ …" lines; drop ANSI colours). */
export function shortError(text: string | undefined, max = 600): string {
  const clean = (text ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean || 'no error message';
}
