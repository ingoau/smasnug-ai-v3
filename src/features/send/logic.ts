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

// ---------- Outcome turns (src/features/outcome-turn.ts) ----------

export type SendOutcome =
  | { kind: 'sent'; permalink?: string; filesFailed?: boolean }
  | { kind: 'not_sent'; reason: 'cancelled' | 'blocked' | 'rate_limited' | 'failed'; detail?: string }
  | { kind: 'expired'; ttlMin: number };

/** The user acted (Send / Cancel): treat it like a mention. Expiry: nobody acted, so the agent may stay silent. */
export const sendOutcomeIsMention = (o: SendOutcome) => o.kind !== 'expired';

/** Where a pending send goes, in Slack markup: a channel link, or "a DM to <@U…>". */
export function destinationLabel(destination: string): string {
  if (/^[UW]/.test(destination)) return `a DM to <@${destination}>`;
  if (/^D/.test(destination)) return 'this DM';
  return `<#${destination}>`;
}

/** Longest part of the message text quoted back in the outcome notice. */
export const OUTCOME_TEXT_MAX = 1500;

const attr = (s: string) => s.replace(/["<>]/g, '');

/**
 * The input of an outcome turn: a system notice (not the speaker's words) saying what happened to the message the
 * agent prepared with send_message. The message itself is the speaker's own content, quoted in <message>.
 */
export function renderSendOutcome(o: { pendingId: string; requesterId: string; destination: string; text: string; outcome: SendOutcome }): string {
  const to = destinationLabel(o.destination);
  const quoted = (o.text.length > OUTCOME_TEXT_MAX ? `${o.text.slice(0, OUTCOME_TEXT_MAX)}…` : o.text).replace(/<\/(send_outcome|message)/gi, '<\\/$1');
  const out = o.outcome;
  const status = out.kind === 'sent' ? 'sent' : out.kind === 'expired' ? 'expired' : `not_sent:${out.reason}`;
  const link = out.kind === 'sent' && out.permalink ? ` link="${attr(out.permalink)}"` : '';
  const who = `<@${o.requesterId}>`;
  const noPing = /^[UW]/.test(o.destination) ? " Don't @mention the recipient (it would ping them)." : '';
  let notice: string;
  if (out.kind === 'sent') {
    const linkText = out.permalink ? ` Link: ${out.permalink}` : ' (no link available)';
    const files = out.filesFailed ? ' The attached files failed to upload, though: say so.' : '';
    notice =
      `${who} clicked Send on the preview, and the message was posted to ${to} on their behalf.${linkText}${files} ` +
      `Confirm it in one short line in your own voice${out.permalink ? ', with the link' : ''} (e.g. "sent, here it is"). ` +
      `Don't repeat the message and don't send it again.${noPing}`;
  } else if (out.kind === 'expired') {
    notice =
      `Nobody clicked Send or Cancel on the preview of the message to ${to} within ${out.ttlMin} min, so it expired and nothing was sent. ` +
      'If the conversation has moved on or they clearly dropped it, stay silent (call end_turn without replying). Otherwise at most one ' +
      `short line that it wasn't sent and they can ask again. Never send it again on your own.${noPing}`;
  } else {
    const why = {
      cancelled: `${who} clicked Cancel on the preview, so nothing was sent to ${to}. Acknowledge it in a few words (e.g. "ok, not sending it"), or ask what to change if that's clearly useful.`,
      blocked: `${who} clicked Send, but nothing was sent to ${to}: they are blocked from sending messages through you. Tell them briefly; don't retry.`,
      rate_limited: `${who} clicked Send, but nothing was sent to ${to}: they hit the hourly limit for messages sent on their behalf. Tell them briefly that they can try again later.`,
      failed: `${who} clicked Send, but nothing was sent to ${to}${out.detail ? ` (${out.detail})` : ''}. Tell them briefly what went wrong.`,
    }[out.reason];
    notice = `${why} Don't send it again unless they ask.${noPing}`;
  }
  return [
    `<send_outcome id="${o.pendingId}" status="${status}" to="${attr(to)}"${link}>`,
    `<message note="the text of the preview: ${who}'s own content">`,
    quoted,
    '</message>',
    '</send_outcome>',
    `System notice (not a message from ${who}): this turn reports what happened to a message you prepared with send_message earlier in this thread. ${notice}`,
  ].join('\n');
}
