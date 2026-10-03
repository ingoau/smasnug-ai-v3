/** Entry guard used at every pipeline entry point (messages, interactions, slash commands, App Home). */
import { env } from '../config.js';
import { checkEntry, type EntryCheck } from '../features/guard.js';
import { log } from '../log.js';

export async function guardEntry(userId: string, channelId?: string): Promise<EntryCheck> {
  const res = await checkEntry(userId, channelId);
  // The admin must always be able to reach the bot (e.g. to lift a suspension), so suspension never blocks them.
  if (!res.ok && res.reason === 'suspended' && env.ADMIN_USER_ID && userId === env.ADMIN_USER_ID) return { ok: true };
  if (!res.ok) log.info({ userId, channelId, reason: res.reason }, 'entry blocked');
  return res;
}
