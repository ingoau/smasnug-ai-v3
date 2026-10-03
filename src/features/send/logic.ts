/** Pure parts of send_message: destination parsing, confirmation decisions, text sanitising. */

export type Destination =
  | { kind: 'thread' }
  | { kind: 'channel'; id: string }
  | { kind: 'channel_name'; name: string }
  | { kind: 'user'; id: string }
  | { kind: 'invalid'; error: string };

const THREAD_WORDS = new Set(['', 'thread', 'here', 'this thread', 'current thread', 'the thread', 'reply']);

export function parseDestination(raw: string, currentChannelId: string): Destination {
  const s = raw.trim();
  if (THREAD_WORDS.has(s.toLowerCase())) return { kind: 'thread' };
  let m: RegExpExecArray | null;
  if ((m = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(s))) return { kind: 'channel', id: m[1]! };
  if ((m = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(s))) return { kind: 'user', id: m[1]! };
  if (/^[CG][A-Z0-9]{6,}$/.test(s)) return { kind: 'channel', id: s };
  if (/^[UW][A-Z0-9]{6,}$/.test(s)) return { kind: 'user', id: s };
  if (/^D[A-Z0-9]{6,}$/.test(s)) {
    // Only the current DM (top level); DMs with other people go through their user id.
    return s === currentChannelId
      ? { kind: 'channel', id: s }
      : { kind: 'invalid', error: 'To message someone directly, use their user id or mention (<@U…>), not a DM channel id.' };
  }
  if ((m = /^#([a-z0-9][a-z0-9._-]{0,79})$/i.exec(s))) return { kind: 'channel_name', name: m[1]!.toLowerCase() };
  return {
    kind: 'invalid',
    error: `Unknown destination "${raw}". Use "thread" (this thread), a channel ("#name", "<#C…>" or a channel id) or a person ("<@U…>" or a user id).`,
  };
}

/** Neutralise broadcast / group pings so the bot can't be used to @channel people. */
export function sanitizeOutgoing(text: string) {
  return text
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/gi, '@​$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/gi, (_m, label) => `@​${String(label ?? 'group').replace(/^@/, '')}`)
    .replace(/(^|\s)@(here|channel|everyone)\b/gi, '$1@​$2');
}

export interface PendingSendRow {
  id: string;
  requesterId: string;
  threadId: string | null;
  destination: string;
  text: string;
  files: { filename: string; content: string }[];
  status: string;
  expiresAt: Date;
}

export type ConfirmDecision = 'ok' | 'not_found' | 'wrong_user' | 'expired' | 'already_sent' | 'cancelled' | 'in_progress';

/** Pure: what a click on Send/Cancel should do. */
export function decideClick(pending: Pick<PendingSendRow, 'requesterId' | 'status' | 'expiresAt'> | undefined, clickerId: string, now = new Date()): ConfirmDecision {
  if (!pending) return 'not_found';
  if (pending.requesterId !== clickerId) return 'wrong_user';
  if (pending.status === 'sent') return 'already_sent';
  if (pending.status === 'sending') return 'in_progress';
  if (pending.status === 'cancelled') return 'cancelled';
  if (pending.status !== 'pending' || pending.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'ok';
}

export const CLICK_REPLIES: Record<Exclude<ConfirmDecision, 'ok'>, { text: string; replace: boolean }> = {
  not_found: { text: 'This expired, ask again.', replace: true },
  expired: { text: 'This expired, ask again.', replace: true },
  wrong_user: { text: 'Only the person who asked can send or cancel this.', replace: false },
  already_sent: { text: 'Already sent.', replace: true },
  in_progress: { text: 'Already sending…', replace: false },
  cancelled: { text: 'Cancelled.', replace: true },
};

export const isUuid = (s: string | undefined): s is string =>
  !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
