/**
 * Agents & AI Apps `app_context_changed`: while the agent container is open, Slack tells us which channel the user is
 * looking at (`event.context.entities`, most relevant first). We keep the latest one per user for a short while and
 * hand it to that user's next DM turn ("User is currently viewing <#C…>").
 */
import { redis } from '../core/redis.js';
import { getBotIdentity } from '../core/slack.js';
import { log } from '../log.js';

const CHANNEL_ENTITY = 'slack#/types/channel_id';
const VIEW_TTL_S = 15 * 60;
export const viewKey = (userId: string) => `view:ctx:${userId}`;

/** The channel id from an app_context_changed event's entities (first channel entity), if any. */
export function viewedChannel(event: any): string | null {
  const entities: any[] = Array.isArray(event?.context?.entities) ? event.context.entities : [];
  const ch = entities.find((e) => e?.type === CHANNEL_ENTITY && typeof e.value === 'string' && /^[CGD][A-Z0-9]+$/.test(e.value));
  return ch?.value ?? null;
}

/** The event carries no user field: the viewing user is in the envelope's `authorizations`. */
async function viewingUser(body: any): Promise<string | null> {
  const bot = await getBotIdentity().catch(() => null);
  const candidates = [body?.event?.user, body?.event?.user_id, ...(Array.isArray(body?.authorizations) ? body.authorizations.map((a: any) => a?.user_id) : [])];
  return candidates.find((u) => typeof u === 'string' && /^[UW][A-Z0-9]+$/.test(u) && u !== bot?.userId) ?? null;
}

export async function handleAppContextChanged(body: any): Promise<void> {
  const userId = await viewingUser(body);
  if (!userId) {
    log.debug({ authorizations: body?.authorizations }, 'app_context_changed without a user');
    return;
  }
  const channelId = viewedChannel(body?.event);
  if (channelId) await redis.set(viewKey(userId), channelId, 'EX', VIEW_TTL_S);
  else await redis.del(viewKey(userId));
  log.debug({ userId, channelId }, 'app context changed');
}

/** The channel the user was last seen viewing in the agent container (within the TTL), excluding `exclude`. */
export async function currentlyViewing(userId: string, exclude?: string): Promise<string | null> {
  const v = await redis.get(viewKey(userId)).catch(() => null);
  return v && v !== exclude ? v : null;
}
