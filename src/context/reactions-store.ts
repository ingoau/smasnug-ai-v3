// OWNER: tools/context module.
/** Atomic update of `messages.reactions`, used by the pipeline (reaction events) and the react/unreact tools. */
import { sql } from '../db/index.js';
import type { MessageReaction } from '../core/types.js';
import { applyReaction } from './reactions.js';

/**
 * Update a stored message's reactions atomically (row lock). Returns the message's thread id (null for channel
 * context rows), or undefined when the message isn't stored — reactions on messages we don't keep are ignored.
 */
export async function updateStoredReaction(opts: { channelId: string; ts: string; op: 'added' | 'removed'; name: string; user: string }): Promise<{ threadId: string | null } | undefined> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ reactions: MessageReaction[]; threadId: string | null }[]>`
      select reactions, thread_id from messages where channel_id = ${opts.channelId} and ts = ${opts.ts} for update`;
    if (!row) return undefined;
    const next = applyReaction(Array.isArray(row.reactions) ? row.reactions : [], opts.op, opts.name, opts.user);
    await tx`update messages set reactions = ${tx.json(next as any)} where channel_id = ${opts.channelId} and ts = ${opts.ts}`;
    return { threadId: row.threadId };
  });
}
