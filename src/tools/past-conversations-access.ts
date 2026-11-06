/** Pure visibility rule for search_past_conversations (no imports with side effects, so it is cheap to test). */
import type { ConversationInfo } from '../context/conversation.js';

export type SourceKind = ConversationInfo['kind'] | 'unknown';
export type PastThreadDecision = 'allow' | 'needs_public' | 'needs_member' | 'deny';

/**
 * Pure: may a past thread in `source` be shown in a search run `here`?
 * - The same conversation: yes (the speaker is in it now).
 * - A public channel (or one we can't classify): only once verified public now (fail-closed).
 * - A private channel or group DM elsewhere: only in the speaker's own DM with the bot, and only while they are
 *   still a member, so nobody else reads it.
 * - Another DM: never.
 */
export function decidePastThread(
  source: { channelId: string; kind: SourceKind },
  here: { channelId: string; kind: SourceKind; imUserId?: string },
  speakerId: string,
): PastThreadDecision {
  if (source.channelId === here.channelId) return 'allow';
  if (source.kind === 'public_channel' || source.kind === 'unknown') return 'needs_public';
  const speakersOwnDm = here.kind === 'dm' && here.imUserId === speakerId;
  if ((source.kind === 'private_channel' || source.kind === 'group_dm') && speakersOwnDm) return 'needs_member';
  return 'deny';
}
