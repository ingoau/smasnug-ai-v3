import type { TurnRow } from '../core/types.js';
import type { ToolContext } from '../core/tools.js';
import type { ReplyManager } from './reply.js';

/** Visible effects a turn can have; a mention turn with none of these gets a fallback message. */
export type VisibleAction = 'reply' | 'react' | 'spawn' | 'steer' | 'resume' | 'cancel' | 'card' | 'send' | 'code_channel';

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
  /**
   * A tool finished the turn's work and posted for it (open_code_channel with `fork`: the conversation moved to the
   * new channel and a link went into this thread): the turn ends after the current step.
   */
  endRequested?: boolean;
  /**
   * An outcome turn (turn.kind 'scheduled' with a stored outcome input, src/features/outcome-turn.ts): its source and
   * ref. For source 'approval', the vault approval's owner (vaultIdentity lets that owner's own outcome turn carry on).
   */
  outcome?: { source: string; sourceRef: string | null; approvalOwnerId?: string | null };
}

export function turnState(ctx: ToolContext): FrontTurnState {
  const s = ctx.extras.agentTurn as FrontTurnState | undefined;
  if (!s) throw new Error('this tool is only available inside a front-agent turn');
  return s;
}

/**
 * Ephemeral mode (`@bot !p …`): the user whose private turn this is, else null (also outside a front turn). Private
 * subagents (subagents.private_to) are visible only to that user's private turns.
 */
export function privateViewer(ctx: Pick<ToolContext, 'extras'>): string | null {
  const s = ctx.extras.agentTurn as FrontTurnState | undefined;
  if (s) return s.turn.ephemeral ? s.turn.authorId : null;
  // A private subagent's run (child.ts).
  const child = ctx.extras[PRIVATE_TO_EXTRA];
  return typeof child === 'string' ? child : null;
}

/** ToolContext.extras key: a private subagent run's owner (child.ts). */
export const PRIVATE_TO_EXTRA = 'privateTo';
