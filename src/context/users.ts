/**
 * Slack user lookups. The workspace directory (src/tools/directory/, `directory_people`) is the one profile store:
 * a lookup reads it and calls users.info (users:read) only when the person is missing or the row hasn't been
 * refreshed for `limits.directoryProfileMaxAgeMs` (24 h; crawls, events and lookups refresh it), then writes the
 * result through. Shared helper: other modules need tz; the front agent's turn message shows profile details
 * (pronouns, title, status, admin/owner).
 */
import { limits } from '../config.js';
import { redis } from '../core/redis.js';
import { SlackBusyError, slackCall, type SlackCallOpts } from '../core/slack.js';
import { log } from '../log.js';
import type { DirectoryPerson } from '../tools/directory/fields.js';
import { getPeople, rememberSlackUser, type PersonRow } from '../tools/directory/store.js';

export interface UserInfo {
  id: string;
  /** Best display name: profile display_name → real_name → handle. */
  name: string;
  realName?: string;
  /** Slack handle (users.info `name`). */
  handle?: string;
  /** IANA time zone, e.g. 'Europe/Berlin'. */
  tz?: string;
  /** Offset from UTC in seconds. */
  tzOffset?: number;
  /** Avatar URL (192px). Only on a fresh users.info answer: the directory doesn't store avatars. */
  image?: string;
  isBot: boolean;
  /** An app's user account (users.info `is_app_user`). */
  isAppUser?: boolean;
  deleted?: boolean;
  /** Profile fields below are user-written: render them via src/context/people.ts (one line, capped). */
  pronouns?: string;
  /** Job title (profile `title`). */
  title?: string;
  statusText?: string;
  /** e.g. ':palm_tree:'. */
  statusEmoji?: string;
  /** Unix seconds when the status clears; 0/undefined = never. The cache can outlive it: check at render time. */
  statusExpiration?: number;
  isAdmin?: boolean;
  isOwner?: boolean;
  /** Slack client locale (users.info `include_locale`), e.g. 'en-US', 'de-DE'. */
  locale?: string;
}

/** A failed lookup (e.g. user_not_found) isn't retried for this long. */
const NEG_TTL_S = 10 * 60;
const missKey = (id: string) => `directory:miss:${id}`;

export function userInfoFromSlack(u: any): UserInfo {
  const p = u?.profile ?? {};
  return {
    id: u.id,
    name: p.display_name || p.real_name || u.real_name || u.name || u.id,
    realName: p.real_name || u.real_name || undefined,
    handle: u.name || undefined,
    tz: u.tz || undefined,
    tzOffset: typeof u.tz_offset === 'number' ? u.tz_offset : undefined,
    image: p.image_192 || p.image_72 || p.image_512 || undefined,
    isBot: !!u.is_bot,
    isAppUser: u.is_app_user ? true : undefined,
    deleted: !!u.deleted,
    pronouns: p.pronouns || undefined,
    title: p.title || undefined,
    statusText: p.status_text || undefined,
    statusEmoji: p.status_emoji || undefined,
    statusExpiration: typeof p.status_expiration === 'number' && p.status_expiration > 0 ? p.status_expiration : undefined,
    isAdmin: u.is_admin ? true : undefined,
    isOwner: u.is_owner || u.is_primary_owner ? true : undefined,
    locale: typeof u.locale === 'string' && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(u.locale) ? u.locale : undefined,
  };
}

/** A directory row as UserInfo (same field semantics as userInfoFromSlack; no avatar). */
export function userInfoFromPerson(p: DirectoryPerson): UserInfo {
  return {
    id: p.id,
    name: p.displayName || p.realName || p.handle || p.id,
    realName: p.realName || undefined,
    handle: p.handle || undefined,
    tz: p.tz || undefined,
    tzOffset: typeof p.tzOffset === 'number' ? p.tzOffset : undefined,
    isBot: p.isBot,
    isAppUser: p.isAppUser ? true : undefined,
    deleted: p.deleted,
    pronouns: p.pronouns || undefined,
    title: p.title || undefined,
    statusText: p.statusText || undefined,
    statusEmoji: p.statusEmoji || undefined,
    statusExpiration: p.statusExpiration && p.statusExpiration > 0 ? p.statusExpiration : undefined,
    isAdmin: p.isAdmin ? true : undefined,
    isOwner: p.isOwner || p.isPrimaryOwner ? true : undefined,
    locale: p.locale || undefined,
  };
}

/** Fresh enough to answer without users.info. */
export function isFreshProfile(row: Pick<PersonRow, 'syncedAt'>, now = Date.now(), maxAgeMs: number = limits.directoryProfileMaxAgeMs): boolean {
  return now - new Date(row.syncedAt).getTime() < maxAgeMs;
}

/** Rate-limit options for the lookup (SlackCallOpts subset): a tool inside a subagent step passes a wait cap. */
export type UserLookupOpts = Pick<SlackCallOpts, 'maxWaitMs' | 'priority' | 'onWait'>;

async function directoryRows(ids: string[]): Promise<Map<string, PersonRow>> {
  try {
    return await getPeople(ids);
  } catch (err) {
    log.warn({ err }, 'directory read failed; falling back to users.info');
    return new Map();
  }
}

/** users.info for a missing / stale row, written through. A stale row is still better than nothing on failure. */
async function fetchUserInfo(userId: string, stale: PersonRow | undefined, opts: UserLookupOpts): Promise<UserInfo | null> {
  if (!stale && (await redis.get(missKey(userId)).catch(() => null))) return null;
  try {
    const res = await slackCall<any>('users.info', { user: userId, include_locale: true }, opts);
    await rememberSlackUser(res.user);
    return userInfoFromSlack({ ...res.user, id: res.user?.id ?? userId });
  } catch (err) {
    if (err instanceof SlackBusyError) {
      log.info({ userId, waitMs: err.waitMs }, 'users.info skipped: rate limited');
    } else {
      log.warn({ err, userId }, 'users.info failed');
      if (!stale) await redis.set(missKey(userId), '1', 'EX', NEG_TTL_S).catch(() => {});
    }
    return stale ? userInfoFromPerson(stale) : null;
  }
}

/**
 * A user's profile: from the directory when present and fresh, else users.info (written through). Returns null if
 * the user can't be looked up (failures aren't retried for a few minutes). With `maxWaitMs`, a lookup the shared rate
 * limiter would hold longer returns the stale row or null (names are a nicety).
 */
export async function getUserInfo(userId: string, opts: UserLookupOpts = {}): Promise<UserInfo | null> {
  const row = (await directoryRows([userId])).get(userId);
  if (row && isFreshProfile(row)) return userInfoFromPerson(row);
  return fetchUserInfo(userId, row, opts);
}

/** Profiles for many users: one directory query, users.info (in parallel) only for the missing / stale ones. */
export async function getUserInfos(ids: string[], opts: UserLookupOpts = {}): Promise<Map<string, UserInfo>> {
  const out = new Map<string, UserInfo>();
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return out;
  const rows = await directoryRows(uniq);
  await Promise.all(
    uniq.map(async (id) => {
      const row = rows.get(id);
      const info = row && isFreshProfile(row) ? userInfoFromPerson(row) : await fetchUserInfo(id, row, opts);
      if (info) out.set(id, info);
    }),
  );
  return out;
}

/** Names for many users at once (see getUserInfos). */
export async function getUserNames(ids: string[], opts: UserLookupOpts = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [id, info] of await getUserInfos(ids, opts)) out.set(id, info.name);
  return out;
}
