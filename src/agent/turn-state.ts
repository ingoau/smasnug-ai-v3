import type { TurnRow } from '../core/types.js';
import type { ToolContext } from '../core/tools.js';
import type { ReplyManager } from './reply.js';

/** Visible effects a turn can have; a mention turn with none of these gets a fallback message. */
export type VisibleAction = 'reply' | 'react' | 'spawn' | 'steer' | 'resume' | 'cancel' | 'card' | 'send';

/** Per-turn state shared by the front agent's tools (ctx.extras.agentTurn). */
export interface FrontTurnState {
  turn: TurnRow;
  threadId: string;
  channelId: string;
  threadTs: string;
  replies: ReplyManager;
  visible: Set<VisibleAction>;
  /** This turn's card (created on first spawn/resume). */
  cardId: number | null;
  /** Subagents spawned in this turn. */
  spawned: Set<string>;
  /** True once this turn delegated work (spawn or resume): no more own lookups, at most one acknowledgement. */
  delegated: boolean;
  /** Reactions attempted this turn (capped at 1; reactions replace replies, never accompany them). */
  reactions: number;
  /** The reaction this turn added, removed again if the turn later replies. */
  reaction: { ts: string; emoji: string } | null;
  /** The current step follows a step that only replied/reacted, with no new messages since: a reply now repeats. */
  afterReplyOnlyStep: boolean;
}

export function turnState(ctx: ToolContext): FrontTurnState {
  const s = ctx.extras.agentTurn as FrontTurnState | undefined;
  if (!s) throw new Error('this tool is only available inside a front-agent turn');
  return s;
}
