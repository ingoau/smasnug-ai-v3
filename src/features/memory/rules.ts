// OWNER: features module.
/**
 * Behaviour rules for one turn (the <rules> section of the turn message): the rules set for this channel (approved
 * channel-scoped workspace facts, workspace.ts) and who in this thread asked not to be @mentioned.
 *
 * Why the second part: a "don't ping me" is saved as the asker's preference, but <speaker_memory> only shows the
 * current speaker's facts, so when someone else talks the bot pinged them anyway (prod, Nov 2026). Only that one
 * narrow, behavioural fact crosses over, as a user id list; nothing else of anyone's memory does.
 */
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { listChannelRules } from '../workspace.js';

/** "doesn't want to be pinged", "prefers not to be @mentioned", "asked never to be tagged": a negation shortly before. */
const NO_PING_RE =
  /\b(?:don'?t|do not|doesn'?t|does not|never|not|no|stop|without|avoid)\b(?:\W+[\w'@]+){0,3}?\W+@?(?:mention(?:ed|s|ing)?|ping(?:ed|s|ing)?|tag(?:ged|s|ging)?|at-?mention(?:ed|s|ing)?)\b/i;

/** Pure: does this saved preference ask the bot not to @mention them? */
export function isNoPingPreference(text: string): boolean {
  return NO_PING_RE.test(text);
}

/** Pure: the section body, or '' when there's nothing to say. */
export function formatRules(o: { channelRules: { text: string }[]; noPing: string[] }): string {
  const lines: string[] = [];
  if (o.channelRules.length)
    lines.push('Rules for this channel, set by its owner or the admin. Follow them like workspace rules:', ...o.channelRules.map((r) => `- ${r.text}`));
  if (o.noPing.length) lines.push(`Asked not to be @mentioned (write their plain name instead): ${o.noPing.map((u) => `<@${u}>`).join(', ')}`);
  return lines.join('\n');
}

/** Of `userIds`, who has a saved preference not to be @mentioned. */
export async function usersAskingNoPing(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await sql<{ userId: string; text: string }[]>`
    select user_id, text from user_memory where kind = 'preference' and user_id in ${sql(userIds)}`;
  const out = new Set<string>();
  for (const r of rows) if (isNoPingPreference(r.text)) out.add(r.userId);
  return userIds.filter((u) => out.has(u));
}

/** The <rules> section for a turn in `channelId` with these participants (speaker included). */
export async function renderTurnRules(channelId: string, participantIds: string[]): Promise<string> {
  const [channelRules, noPing] = await Promise.all([
    listChannelRules(channelId).catch((err) => (log.warn({ err }, 'listChannelRules failed'), [])),
    usersAskingNoPing([...new Set(participantIds)]).catch((err) => (log.warn({ err }, 'no-ping lookup failed'), [])),
  ]);
  return formatRules({ channelRules, noPing });
}
