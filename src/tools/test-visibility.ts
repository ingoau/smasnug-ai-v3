/**
 * Tests only: forget the public-channel verdicts (`channelVisibility`) for channel ids matching `glob` (`*` = any
 * run of characters): the Redis cache and the directory rows that earlier checks wrote through, so the next check
 * asks conversations.info (the fake Slack) again.
 */
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';

export async function forgetChannelVisibility(glob: string): Promise<void> {
  const keys = await redis.keys(`slack:chanvis:${glob}`);
  if (keys.length) await redis.del(...keys);
  await sql`delete from directory_channels where id like ${glob.replace(/\*/g, '%')}`;
}
