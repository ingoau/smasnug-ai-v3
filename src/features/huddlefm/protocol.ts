/**
 * HuddleFM bot API wire format (https://github.com/ingoau/huddlefm/blob/main/docs/bot-api.md). Pure helpers, no I/O.
 *
 * Commands are JSON in the text of a top-level DM to the HuddleFM user; replies come back threaded under the command
 * (`replyTo` = the command's ts), events as top-level DMs (`type: "event"`). Every message has `v: 1`.
 */

/** Capabilities the bot asks the host for. Never `end-session` (the bot can't end a session) or `configure-settings`. */
export const REQUESTED_PERMISSIONS = ['add', 'add-bulk', 'remove-own', 'manage-queue', 'skip', 'pause', 'volume', 'clear'] as const;
/** Event subscriptions: session end, track changes (auto DJ, chatter, skip feedback) and queue changes. */
export const REQUESTED_EVENTS = ['session', 'track', 'queue'] as const;

/** Errors that mean the grant is gone: DJ mode is over for that channel. */
export const LOST_GRANT_ERRORS: ReadonlySet<string> = new Set(['not_granted', 'session_not_found', 'session_inactive']);

/** Replies that resolve a request_control (threaded under the request, possibly minutes later). */
export const GRANT_TYPES = ['grant_accepted', 'grant_declined', 'grant_expired', 'grant_revoked'] as const;
export type GrantType = (typeof GRANT_TYPES)[number];
export const isGrantType = (t: unknown): t is GrantType => (GRANT_TYPES as readonly unknown[]).includes(t);

export interface HfmTrack {
  id?: string;
  title?: string;
  artist?: string;
  /** Picked by HuddleFM's own autoplay, not by a person. */
  automatic?: boolean;
}

export interface HfmMessage {
  v: 1;
  ok?: boolean;
  type?: string;
  replyTo?: string;
  error?: string;
  message?: string;
  channel?: string;
  event?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export type HfmCommand = { type: string; channel?: string } & Record<string, unknown>;

/**
 * Command → message text. Slack entity-escapes `&`, `<`, `>` in message text and turns URLs into `<url>` links, which
 * HuddleFM would read verbatim. JSON's own escapes (`<`, `\/`) keep those characters out of the text while
 * decoding to the same JSON.
 */
export function encodeCommand(cmd: HfmCommand): string {
  return JSON.stringify({ v: 1, ...cmd })
    .replace(/[&<>]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`)
    .replace(/\//g, '\\/');
}

/** Undo Slack's formatting of message text: `<url|label>` / `<url>` links back to the url, then entities. */
export function unformatSlackText(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^>|]*)(?:\|[^>]*)?>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Message text → a HuddleFM message, or null for anything that isn't one (other text, other JSON). */
export function decodeMessage(text: string | undefined): HfmMessage | null {
  if (!text) return null;
  const raw = unformatSlackText(text).trim();
  if (!raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.v === 1 ? (parsed as HfmMessage) : null;
  } catch {
    return null;
  }
}

/** "Title - Artist" (whatever is known). */
export function trackLabel(t: HfmTrack | null | undefined): string {
  if (!t) return '';
  return [t.title, t.artist].filter((s) => typeof s === 'string' && s.trim()).join(' - ');
}

/** Comparable form of a song for de-duplication: lowercase, no brackets (feat., remaster…), no punctuation. */
export function songKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(?:feat|ft|featuring)\b\.?[^-]*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Readable error for the model from a failed reply. */
export function replyError(reply: HfmMessage | null): string {
  if (!reply) return 'HuddleFM did not answer in time';
  return [reply.error, reply.message].filter(Boolean).join(': ') || 'HuddleFM refused it';
}

/** `channel` argument from the model: a bare id, `<#C123|name>` or `#C123`. */
export function parseChannelArg(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /\b([CG][A-Z0-9]{6,})\b/.exec(raw);
  return m ? m[1]! : null;
}

/** Append to a capped history list (newest last). */
export function capped(list: readonly string[], add: readonly string[], max: number): string[] {
  return [...list, ...add].slice(-max);
}
