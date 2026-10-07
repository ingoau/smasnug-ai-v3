/**
 * Pure mapping of Slack's user and channel objects to directory rows (src/tools/directory/). Only the fields listed
 * here are ever kept: no email, phone, avatar or any other profile field. The searchable ones are SEARCHABLE_*;
 * the rest (pronouns, tz, locale, status, admin flags) are display-only.
 */

/** A people row (directory_people), camelCase as postgres.js returns it. */
export interface DirectoryPerson {
  id: string;
  handle: string;
  displayName: string;
  realName: string;
  title: string;
  pronouns: string;
  tz: string | null;
  tzOffset: number | null;
  /** null = unknown (user_change events don't carry it): an update keeps the stored value. */
  locale: string | null;
  statusText: string;
  statusEmoji: string;
  statusExpiration: number | null;
  isAdmin: boolean;
  isOwner: boolean;
  isPrimaryOwner: boolean;
  isBot: boolean;
  isAppUser: boolean;
  deleted: boolean;
}

/** The only people fields find_people matches. Pronouns, status, tz and the rest are display-only. */
export const SEARCHABLE_PEOPLE_FIELDS = ['handle', 'displayName', 'realName', 'title'] as const;

/** The stored people fields, in column order (also the change-detection set). */
export const PEOPLE_FIELDS = [
  'id',
  'handle',
  'displayName',
  'realName',
  'title',
  'pronouns',
  'tz',
  'tzOffset',
  'locale',
  'statusText',
  'statusEmoji',
  'statusExpiration',
  'isAdmin',
  'isOwner',
  'isPrimaryOwner',
  'isBot',
  'isAppUser',
  'deleted',
] as const satisfies readonly (keyof DirectoryPerson)[];

/** A channel row (directory_channels): public channels only. */
export interface DirectoryChannel {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  isArchived: boolean;
  /** null = unknown (events): an update keeps the stored value. */
  memberCount: number | null;
  createdAt: Date | null;
}

const MAX_FIELD = 250;

/** Stored text: a string, control chars removed, trimmed, capped (user-written, so untrusted). '' for anything else. */
export function cleanText(s: unknown, max = MAX_FIELD): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const LOCALE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** A Slack user object (users.list, users.info, user_change, team_join) → a people row, or null if it has no id. */
export function personFromSlack(u: any): DirectoryPerson | null {
  if (!u || typeof u.id !== 'string' || !/^[UW][A-Z0-9]{2,}$/.test(u.id)) return null;
  const p = u.profile ?? {};
  const exp = Number(p.status_expiration);
  // A deactivated account keeps only what identifies it (names, title, kind): no pronouns, status, tz, locale or roles.
  if (u.deleted) {
    return {
      id: u.id,
      handle: cleanText(u.name, 80),
      displayName: cleanText(p.display_name, 80),
      realName: cleanText(p.real_name || u.real_name, 120),
      title: cleanText(p.title),
      pronouns: '',
      tz: null,
      tzOffset: null,
      locale: null,
      statusText: '',
      statusEmoji: '',
      statusExpiration: null,
      isAdmin: false,
      isOwner: false,
      isPrimaryOwner: false,
      isBot: !!u.is_bot,
      isAppUser: !!u.is_app_user,
      deleted: true,
    };
  }
  return {
    id: u.id,
    handle: cleanText(u.name, 80),
    displayName: cleanText(p.display_name, 80),
    realName: cleanText(p.real_name || u.real_name, 120),
    title: cleanText(p.title),
    pronouns: cleanText(p.pronouns, 60),
    tz: typeof u.tz === 'string' && TZ_RE.test(u.tz) ? u.tz : null,
    tzOffset: typeof u.tz_offset === 'number' && Number.isFinite(u.tz_offset) ? Math.trunc(u.tz_offset) : null,
    locale: typeof u.locale === 'string' && LOCALE_RE.test(u.locale) ? u.locale : null,
    statusText: cleanText(p.status_text, 150),
    statusEmoji: cleanText(p.status_emoji, 80),
    statusExpiration: Number.isFinite(exp) && exp > 0 ? Math.trunc(exp) : null,
    isAdmin: !!u.is_admin,
    isOwner: !!u.is_owner,
    isPrimaryOwner: !!u.is_primary_owner,
    isBot: !!u.is_bot,
    isAppUser: !!u.is_app_user,
    deleted: !!u.deleted,
  };
}

/**
 * A Slack user object reduced to the raw keys personFromSlack reads, for event payloads queued by ingress (BullMQ
 * keeps finished jobs for a while: email, phone, avatars etc. never get there).
 */
export function slimSlackUser(u: any): any {
  if (!u || typeof u !== 'object') return u;
  const p = u.profile ?? {};
  const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    ...pick(u, ['id', 'name', 'real_name', 'deleted', 'is_bot', 'is_app_user', 'is_admin', 'is_owner', 'is_primary_owner', 'tz', 'tz_offset', 'locale']),
    profile: pick(p, ['display_name', 'real_name', 'title', 'pronouns', 'status_text', 'status_emoji', 'status_expiration']),
  };
}

/** True if a stored field differs (locale null = unknown, never a change). */
export function personChanged(stored: DirectoryPerson, next: DirectoryPerson): boolean {
  return PEOPLE_FIELDS.some((k) => {
    if (k === 'locale' && next.locale === null && !next.deleted) return false;
    return (stored[k] ?? null) !== (next[k] ?? null);
  });
}

/**
 * A conversations.list / conversations.info channel → a row, or null unless it is positively a public channel
 * (fail closed: `is_private` must be false, not an IM / MPIM / group, a C… id).
 */
export function channelFromSlack(c: any): DirectoryChannel | null {
  if (!c || typeof c.id !== 'string' || !/^C[A-Z0-9]{2,}$/.test(c.id)) return null;
  if (c.is_private !== false || c.is_im || c.is_mpim || c.is_group || c.is_channel === false) return null;
  const name = cleanText(c.name, 80);
  if (!name) return null;
  const created = Number(c.created);
  return {
    id: c.id,
    name,
    topic: cleanText(c.topic?.value),
    purpose: cleanText(c.purpose?.value),
    isArchived: !!c.is_archived,
    memberCount: typeof c.num_members === 'number' ? c.num_members : null,
    createdAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000) : null,
  };
}

/** What a Slack event means for the directory (pure; see events.ts for the effects). */
export type DirectoryAction =
  | { type: 'person'; person: DirectoryPerson }
  /** A channel we may not have yet: verify it's public (conversations.info) before storing. */
  | { type: 'channel_refresh'; channelId: string; name?: string }
  | { type: 'channel_archived'; channelId: string; archived: boolean }
  | { type: 'channel_deleted'; channelId: string }
  | { type: 'channel_text'; channelId: string; field: 'topic' | 'purpose'; value: string }
  | { type: 'channel_renamed'; channelId: string; name: string };

/** Event types the directory handles (bot_events in slack-manifest.yml). */
export const DIRECTORY_EVENTS = new Set(['user_change', 'team_join', 'channel_created', 'channel_rename', 'channel_archive', 'channel_unarchive', 'channel_deleted']);

/** A Slack event → directory actions ([] when it means nothing for the directory). */
export function directoryActions(ev: any): DirectoryAction[] {
  switch (ev?.type) {
    case 'user_change':
    case 'team_join': {
      const person = personFromSlack(ev.user);
      return person ? [{ type: 'person', person }] : [];
    }
    case 'channel_created': {
      const id = ev.channel?.id;
      return typeof id === 'string' ? [{ type: 'channel_refresh', channelId: id }] : [];
    }
    case 'channel_rename': {
      const id = ev.channel?.id;
      const name = cleanText(ev.channel?.name, 80);
      return typeof id === 'string' && name ? [{ type: 'channel_renamed', channelId: id, name }] : [];
    }
    case 'channel_archive':
    case 'channel_unarchive':
      return typeof ev.channel === 'string' ? [{ type: 'channel_archived', channelId: ev.channel, archived: ev.type === 'channel_archive' }] : [];
    case 'channel_deleted':
      return typeof ev.channel === 'string' ? [{ type: 'channel_deleted', channelId: ev.channel }] : [];
    case 'message': {
      // Topic / purpose / name changes arrive as message subtypes in channels the bot is in. Public channels only
      // (`channel_type` 'channel'); the update only touches rows that exist, i.e. verified public channels.
      if (ev.channel_type !== 'channel' || typeof ev.channel !== 'string') return [];
      if (ev.subtype === 'channel_topic') return [{ type: 'channel_text', channelId: ev.channel, field: 'topic', value: cleanText(ev.topic) }];
      if (ev.subtype === 'channel_purpose') return [{ type: 'channel_text', channelId: ev.channel, field: 'purpose', value: cleanText(ev.purpose) }];
      if (ev.subtype === 'channel_name' && cleanText(ev.name, 80)) return [{ type: 'channel_renamed', channelId: ev.channel, name: cleanText(ev.name, 80) }];
      return [];
    }
    default:
      return [];
  }
}
