// OWNER: pipeline module. Stub signature — implemented by the pipeline agent.
import type { TurnRow } from '../core/types.js';

/**
 * Create a pending turn for a thread and make sure a thread-run job will process it.
 * Used by the agent module to request a synthesis turn when all runs on a card have finished.
 */
export async function requestTurn(opts: {
  threadId: string;
  authorId: string;
  kind: TurnRow['kind'];
  cardId?: number;
  messageTs?: string[];
  isMention?: boolean;
}): Promise<number> {
  throw new Error('not implemented');
}
