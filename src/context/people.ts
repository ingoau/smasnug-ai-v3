// OWNER: tools/context module.
/**
 * Pure rendering of people for the front agent's turn message: the speaker's profile details and the thread's
 * other participants. Profile fields are written by the users themselves, so they are untrusted: one line each,
 * length-capped, no angle brackets (they can't fake a section tag or a mention).
 */
import type { UserInfo } from './users.js';

/** Max chars per user-written profile field. */
export const PROFILE_FIELD_MAX = 80;
/** Participants listed per turn. */
export const MAX_PARTICIPANTS = 10;

/** A user-written profile field as one safe line: control chars / newlines / angle brackets removed, capped. */
export function profileText(s: unknown, max = PROFILE_FIELD_MAX): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** A Slack status emoji code (`:palm_tree:`) or nothing. */
function emojiCode(s: unknown): string | undefined {
  return typeof s === 'string' && /^:[a-z0-9_+'-]{1,64}:$/i.test(s.trim()) ? s.trim() : undefined;
}

/** The status (emoji + text) if one is set and not expired at `now`. */
export function currentStatus(u: Pick<UserInfo, 'statusText' | 'statusEmoji' | 'statusExpiration'>, now: Date): string | undefined {
  if (u.statusExpiration && u.statusExpiration * 1000 <= now.getTime()) return undefined;
  const parts = [emojiCode(u.statusEmoji), profileText(u.statusText)].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

/** The Slack workspace role ("Slack workspace owner" / "Slack workspace admin") or nothing. A Slack role, not a bot one. */
export function workspaceRole(u: Pick<UserInfo, 'isAdmin' | 'isOwner'>): string | undefined {
  if (u.isOwner) return 'Slack workspace owner';
  if (u.isAdmin) return 'Slack workspace admin';
  return undefined;
}

/**
 * Profile lines for the <speaker> section (missing fields omitted), e.g.
 *   Pronouns: she/her
 *   Title: Event organiser
 *   Status: :palm_tree: on vacation
 */
export function speakerDetailLines(u: UserInfo | null | undefined, now: Date): string[] {
  if (!u) return [];
  const lines: string[] = [];
  const pronouns = profileText(u.pronouns);
  const title = profileText(u.title);
  const status = currentStatus(u, now);
  if (pronouns) lines.push(`Pronouns: ${pronouns}`);
  if (title) lines.push(`Title: ${title}`);
  if (status) lines.push(`Status: ${status}`);
  if (u.locale) lines.push(`Slack language: ${u.locale}`);
  return lines;
}

/**
 * The <speaker> `Privileges:` line: bot-level roles first (code-derived: `botAdmin` = ADMIN_USER_ID, which runs
 * moderation, the kill switches and, when configured, coding agents), then the Slack workspace role (from users.info;
 * it grants nothing in the bot). "none" for everyone else, so the model never guesses.
 */
export function privilegesLine(u: Pick<UserInfo, 'isAdmin' | 'isOwner'> | null | undefined, opts: { botAdmin: boolean; codingAgents: boolean }): string {
  const parts: string[] = [];
  if (opts.botAdmin) parts.push(`bot admin (runs this bot: moderation, kill switches${opts.codingAgents ? '; can launch coding agents' : ''})`);
  const role = u ? workspaceRole(u) : undefined;
  if (role) parts.push(role);
  return `Privileges: ${parts.length ? parts.join(', ') : 'none'}`;
}

/** One participant line: `<@U…> Name — pronouns, title` (missing fields omitted). */
export function participantLine(u: UserInfo): string {
  const name = profileText(u.name) ?? u.id;
  const extra = [profileText(u.pronouns), profileText(u.title)].filter(Boolean);
  return `<@${u.id}> ${name}${extra.length ? ` — ${extra.join(', ')}` : ''}`;
}

/** Unique ids in order (most recent first), without the excluded ones, at most `max`. */
export function pickParticipantIds(idsMostRecentFirst: string[], exclude: Iterable<string | undefined>, max = MAX_PARTICIPANTS): string[] {
  const skip = new Set([...exclude].filter(Boolean));
  const out: string[] = [];
  for (const id of idsMostRecentFirst) {
    if (out.length >= max) break;
    if (!id || skip.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** The <participants> body: one line per looked-up human (bots, deleted and failed lookups left out). */
export function renderParticipants(infos: (UserInfo | null | undefined)[]): string {
  return infos
    .filter((u): u is UserInfo => !!u && !u.isBot && !u.deleted)
    .map(participantLine)
    .join('\n');
}

/** Current UTC time with the weekday, e.g. "Tuesday 2026-10-07 01:23 UTC". */
export function formatUtcNow(now: Date): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(now);
  return `${weekday} ${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)} UTC`;
}
