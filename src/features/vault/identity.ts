/**
 * Who may use whose credentials (docs/vault.md, "Identity"). Only Slack-verified identity counts: the front turn's
 * author on a *user* turn (someone messaging the bot), or a subagent's owner. Never a tool argument, a mention, or the
 * person who steered a subagent. Reminders, watches, outcome and synthesis turns get nothing.
 */
import type { ToolContext } from '../../core/tools.js';
import type { FrontTurnState } from '../../agent/turn-state.js';

export type Identity = { ok: true; ownerId: string; role: 'front' | 'child'; subagentId?: string } | { ok: false; reason: string };

export function vaultIdentity(ctx: ToolContext): Identity {
  if (ctx.role === 'child') {
    if (!ctx.subagentId || !ctx.speakerId) return { ok: false, reason: 'Credentials are only available in a subagent run.' };
    return { ok: true, ownerId: ctx.speakerId, role: 'child', subagentId: ctx.subagentId };
  }
  if (ctx.role !== 'front') return { ok: false, reason: 'Not available here.' };
  const s = ctx.extras.agentTurn as FrontTurnState | undefined;
  if (!s) return { ok: false, reason: 'Not available here.' };
  if (s.turn.kind !== 'user') return { ok: false, reason: "Credentials can only be used in a turn started by their owner's own message." };
  if (!s.turn.authorId || s.turn.authorId !== ctx.speakerId) return { ok: false, reason: 'Credentials belong to the person you are answering; none is available.' };
  return { ok: true, ownerId: s.turn.authorId, role: 'front' };
}
