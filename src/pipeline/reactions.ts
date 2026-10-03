/**
 * reaction_added / reaction_removed: keep `messages.reactions` current for messages we store. Reactions never start
 * a turn and never go through the gate; reactions on messages we don't store are ignored.
 */
import { appendEvent } from '../core/events.js';
import { updateStoredReaction } from '../context/reactions-store.js';

export interface ReactionEvent {
  type: 'reaction_added' | 'reaction_removed';
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  item_user?: string;
  event_ts?: string;
}

export async function handleReactionEvent(ev: ReactionEvent): Promise<void> {
  const item = ev.item;
  if (item?.type !== 'message' || !item.channel || !item.ts || !ev.user || !ev.reaction) return;
  const op = ev.type === 'reaction_added' ? 'added' : 'removed';
  const res = await updateStoredReaction({ channelId: item.channel, ts: item.ts, op, name: ev.reaction, user: ev.user });
  if (!res?.threadId) return; // not stored, or a channel-context message outside any thread we track
  await appendEvent(res.threadId, ev.type, ev.user, { emoji: ev.reaction, ts: item.ts });
}
