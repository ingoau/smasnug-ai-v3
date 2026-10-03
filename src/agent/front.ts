// OWNER: agent module. Stub signature — implemented by the agent agent.
import type { StoredMessage, TurnRow } from '../core/types.js';

export interface TurnIO {
  /** Messages pushed to this turn's inbox since the last drain (same author). Call before every model step. */
  drainInbox(): Promise<StoredMessage[]>;
  /** 'final' once the model is producing its last step (no more tool calls) — new messages then wait for the next turn. */
  setPhase(phase: 'tools' | 'final'): Promise<void>;
  /** True when this turn was triggered by a mention or DM (status indicator allowed). */
  isMention: boolean;
}

/** Run one front-agent turn. Called by the pipeline under the thread lock; exactly one speaker per turn. */
export async function runFrontTurn(turn: TurnRow, io: TurnIO): Promise<void> {
  throw new Error('not implemented');
}
