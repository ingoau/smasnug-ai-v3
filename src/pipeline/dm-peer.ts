/**
 * Intake hygiene for DMs: a DM whose other party is a bot or an app (not a person) never starts a turn. The DM's
 * other party is the human-looking author of a message in it (the bot's own messages are filtered before), so one
 * cached users.info lookup per DM channel decides it. Lookup failures fail open (DMs are the bot's main entry point).
 */
import { redis } from '../core/redis.js';
import { getUserInfo, type UserInfo } from '../context/users.js';
import { isSlackbotUser } from './rules.js';

const key = (channelId: string) => `dm:peer:v1:${channelId}`;
/** The other party of a DM channel never changes: cache the verdict for a week. */
const TTL_S = 7 * 24 * 60 * 60;

/** Pure: does this users.info record belong to a bot or an app rather than a person? */
export function isNonHumanPeer(userId: string, info: Pick<UserInfo, 'isBot' | 'isAppUser'> | null): boolean {
  if (isSlackbotUser(userId)) return true;
  return Boolean(info && (info.isBot || info.isAppUser));
}

/** True when the DM channel's other party (the author `userId`) is a bot or app. Cached per channel. */
export async function isBotPeerDm(channelId: string, userId: string): Promise<boolean> {
  const cached = await redis.get(key(channelId));
  if (cached) return cached === 'bot';
  if (isSlackbotUser(userId)) {
    await redis.set(key(channelId), 'bot', 'EX', TTL_S);
    return true;
  }
  const info = await getUserInfo(userId);
  if (!info) return false; // unknown: fail open, not cached
  const bot = isNonHumanPeer(userId, info);
  await redis.set(key(channelId), bot ? 'bot' : 'human', 'EX', TTL_S);
  return bot;
}
