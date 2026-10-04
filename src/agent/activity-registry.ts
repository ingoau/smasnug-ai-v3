/**
 * Crash safety for activity messages (activity-trail.ts): while a turn holds an open activity message, its ts is
 * recorded in Redis per turn. If the worker dies mid-turn, the stale-turn sweep (or shutdown) removes the message, so
 * no task card is left spinning in the thread. Best-effort: nothing here throws.
 */
import { redis } from '../core/redis.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';

const key = (turnId: number) => `activity:open:${turnId}`;
/** Outlives any turn; a crashed turn's sweep runs when its thread is next picked up. */
const TTL_S = 24 * 3600;

export async function recordOpenActivity(turnId: number, channelId: string, ts: string): Promise<void> {
  await redis.set(key(turnId), JSON.stringify({ channelId, ts }), 'EX', TTL_S);
}

export async function forgetOpenActivity(turnId: number): Promise<void> {
  await redis.del(key(turnId));
}

/** An abandoned turn (crash, shutdown): stop and delete the activity message it left open, if any. Never throws. */
export async function removeOpenActivity(turnId: number): Promise<void> {
  try {
    const v = await redis.getdel(key(turnId));
    if (!v) return;
    const { channelId, ts } = JSON.parse(v) as { channelId: string; ts: string };
    await slackCall('chat.stopStream', { channel: channelId, ts }).catch((err) => log.debug({ code: slackErrorCode(err) }, 'stopping an abandoned activity message failed'));
    await slackCall('chat.delete', { channel: channelId, ts });
    log.info({ turnId, channelId, ts }, 'removed the activity message of an abandoned turn');
  } catch (err) {
    log.warn({ err, turnId }, 'removing an abandoned activity message failed');
  }
}
