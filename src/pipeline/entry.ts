/** Entry guard used at every pipeline entry point (messages, interactions, slash commands, App Home). */
import { checkEntry, type EntryCheck } from '../features/guard.js';
import { log } from '../log.js';

/**
 * - Conversation turns: `guardEntry(user, channel)` — counts against messages/hour, honours channel disable.
 * - Interactions / slash / App Home: `guardEntry(user, undefined, { countMessage: false })` — no channel, so e.g.
 *   `/smasnug on` still works in a disabled channel.
 * - `allowSuspended`: let suspended users through (App Home, `mem:*` so they can delete their own memory).
 * The admin bypass for pause/suspension lives in checkEntry itself.
 */
export async function guardEntry(
  userId: string,
  channelId?: string,
  opts: { countMessage?: boolean; allowSuspended?: boolean } = {},
): Promise<EntryCheck> {
  const res = await checkEntry(userId, channelId, { countMessage: opts.countMessage });
  if (!res.ok && res.reason === 'suspended' && opts.allowSuspended) return { ok: true };
  if (!res.ok) log.info({ userId, channelId, reason: res.reason }, 'entry blocked');
  return res;
}
