/**
 * Slack user lookups (users.info, needs only users:read), cached in Redis for ~1 day. Shared helper: other modules
 * need tz and avatar; the front agent's turn message shows profile details (pronouns, title, status, admin/owner).
 */
import { redis } from '../core/redis.js';
import { slackCall } from '../core/slack.js';
import { log } from '../log.js';

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
  /** Avatar URL (192px). */
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

const TTL_S = 24 * 60 * 60;
const NEG_TTL_S = 10 * 60;
/** v3: entries carry the locale too; v2 entries (profile details, no locale) simply age out. */
const key = (id: string) => `slack:user:v3:${id}`;

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

/** users.info with a Redis cache. Returns null if the user can't be looked up (cached briefly). */
export async function getUserInfo(userId: string): Promise<UserInfo | null> {
  const cached = await redis.get(key(userId));
  if (cached) return cached === 'null' ? null : (JSON.parse(cached) as UserInfo);
  try {
    const res = await slackCall<any>('users.info', { user: userId, include_locale: true });
    const info = userInfoFromSlack(res.user);
    await redis.set(key(userId), JSON.stringify(info), 'EX', TTL_S);
    return info;
  } catch (err) {
    log.warn({ err, userId }, 'users.info failed');
    await redis.set(key(userId), 'null', 'EX', NEG_TTL_S);
    return null;
  }
}

/** Names for many users at once (parallel, cached). */
export async function getUserNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const infos = await Promise.all(ids.map((id) => getUserInfo(id)));
  infos.forEach((info, i) => {
    if (info) out.set(ids[i]!, info.name);
  });
  return out;
}
