/** Slack user lookups (users.info), cached in Redis for ~1 day. Shared helper: other modules need tz and avatar. */
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
  deleted?: boolean;
}

const TTL_S = 24 * 60 * 60;
const NEG_TTL_S = 10 * 60;
const key = (id: string) => `slack:user:${id}`;

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
    deleted: !!u.deleted,
  };
}

/** users.info with a Redis cache. Returns null if the user can't be looked up (cached briefly). */
export async function getUserInfo(userId: string): Promise<UserInfo | null> {
  const cached = await redis.get(key(userId));
  if (cached) return cached === 'null' ? null : (JSON.parse(cached) as UserInfo);
  try {
    const res = await slackCall<any>('users.info', { user: userId });
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
