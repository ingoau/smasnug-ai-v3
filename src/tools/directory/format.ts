/**
 * Pure rendering of directory results. Profile and channel text is user-written: one line per field, control
 * characters and newlines removed, angle brackets dropped (no fake tags or mentions), group pings neutralised,
 * capped. Callers wrap the whole output with `untrusted()`.
 */
import { neutralizeBroadcasts } from '../../pipeline/guidelines.js';
import type { DirectoryChannel, DirectoryPerson } from './fields.js';

/** User-written text as one safe line: no control chars / newlines / angle brackets, group pings neutralised, capped. */
export function safeLine(s: unknown, max = 80): string {
  if (typeof s !== 'string') return '';
  // Group pings first (<!here>, <!subteam^…>, @channel → zero-width-space forms), then the brackets go.
  const t = neutralizeBroadcasts(s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '))
    .replace(/[<>]/g, '')
    .replace(/!(here|channel|everyone|subteam)/gi, '!\u200b$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** `<@U…> display name (handle) · real name · title · pronouns · bot/person · deactivated` (missing parts omitted). */
export function formatPerson(p: DirectoryPerson): string {
  const display = safeLine(p.displayName) || safeLine(p.realName) || safeLine(p.handle) || p.id;
  const handle = safeLine(p.handle, 40);
  const real = safeLine(p.realName);
  const parts = [`<@${p.id}> ${display}${handle && handle !== display ? ` (${handle})` : ''}`];
  if (real && real !== display) parts.push(real);
  const title = safeLine(p.title, 100);
  if (title) parts.push(title);
  const pronouns = safeLine(p.pronouns, 30);
  if (pronouns && !p.deleted) parts.push(pronouns);
  parts.push(p.isBot || p.isAppUser ? 'bot' : 'person');
  if (p.deleted) parts.push('deactivated');
  return parts.join(' · ');
}

/** `<#C…|name> · purpose (or topic), truncated · N members · archived`. */
export function formatChannel(c: DirectoryChannel): string {
  const name = safeLine(c.name, 80).replace(/[|\s]/g, '-');
  const about = safeLine(c.purpose, 160) || safeLine(c.topic, 160);
  const parts = [`<#${c.id}|${name}>`];
  if (about) parts.push(about);
  if (typeof c.memberCount === 'number') parts.push(`${c.memberCount} member${c.memberCount === 1 ? '' : 's'}`);
  if (c.isArchived) parts.push('archived');
  return parts.join(' · ');
}

/** The note shown while a kind's first crawl hasn't completed. */
export function buildingNote(what: 'people' | 'channels', percent: number): string {
  return `[The ${what} directory is still building (${percent}% done), so results may be incomplete. If you don't find it here, try slack_search.]`;
}
