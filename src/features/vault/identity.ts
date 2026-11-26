/**
 * Who may use whose credentials (docs/vault.md, "Identity"). Only Slack-verified identity counts: the front turn's
 * author on a *user* turn (someone messaging the bot), or a subagent's owner. Never a tool argument, a mention, or the
 * person who steered a subagent. Reminders, watches and synthesis turns get nothing; an outcome turn gets the vault
 * only when it reports one of its own author's vault approvals (so the agent can carry on after "Add it").
 *
 * Subagents: only while every trigger came from the owner on a user turn (subagents.vault_trusted, set at spawn on the
 * owner's own user turn, cleared for good when anyone else, or any non-user turn, steers or resumes it). child.ts
 * passes it in as a mutable VaultTrust under VAULT_TRUST_EXTRA and clears it as soon as such a steer is read.
 */
import type { ToolContext } from '../../core/tools.js';
import type { FrontTurnState } from '../../agent/turn-state.js';
import { sql } from '../../db/index.js';

export type VaultIdentity = { ok: true; ownerId: string; role: 'front' | 'child'; subagentId?: string };
export type Identity = VaultIdentity | { ok: false; reason: string };

/** ctx.extras key (child runs): the run's VaultTrust. */
export const VAULT_TRUST_EXTRA = 'vaultTrust';
export interface VaultTrust {
  trusted: boolean;
}

export function vaultIdentity(ctx: ToolContext): Identity {
  if (ctx.role === 'child') {
    if (!ctx.subagentId || !ctx.speakerId) return { ok: false, reason: 'Credentials are only available in a subagent run.' };
    const trust = ctx.extras[VAULT_TRUST_EXTRA] as VaultTrust | undefined;
    if (!trust?.trusted)
      return {
        ok: false,
        reason:
          `This subagent was started or steered by someone other than <@${ctx.speakerId}>, or by an automatic turn, so it can't use <@${ctx.speakerId}>'s credentials. ` +
          'Say so in your result: they can start a new subagent with their own message (seed_from this one to keep its findings).',
      };
    return { ok: true, ownerId: ctx.speakerId, role: 'child', subagentId: ctx.subagentId };
  }
  if (ctx.role !== 'front') return { ok: false, reason: 'Not available here.' };
  const s = ctx.extras.agentTurn as FrontTurnState | undefined;
  if (!s) return { ok: false, reason: 'Not available here.' };
  if (s.turn.kind !== 'user' && !ownApprovalOutcome(s)) return { ok: false, reason: "Credentials can only be used in a turn started by their owner's own message." };
  if (!s.turn.authorId || s.turn.authorId !== ctx.speakerId) return { ok: false, reason: 'Credentials belong to the person you are answering; none is available.' };
  return { ok: true, ownerId: s.turn.authorId, role: 'front' };
}

/** A scheduled turn reporting a vault approval (source 'approval') whose owner is this turn's author. */
function ownApprovalOutcome(s: FrontTurnState): boolean {
  return s.turn.kind === 'scheduled' && s.outcome?.source === 'approval' && Boolean(s.outcome.approvalOwnerId) && s.outcome.approvalOwnerId === s.turn.authorId;
}

/** The owner of the vault approval an outcome turn reports (front.ts sets FrontTurnState.outcome with it). */
export async function approvalOwner(approvalId: string | null): Promise<string | null> {
  if (!approvalId || !/^[0-9a-f-]{36}$/i.test(approvalId)) return null;
  const [r] = await sql<{ ownerId: string }[]>`select owner_id from vault_approvals where id = ${approvalId}`;
  return r?.ownerId ?? null;
}

/**
 * The grant key ("Allow for 10 min here", vault_grants.grant_key) for `base` (e.g. `cred:<id>`, `cred:<id>:sandbox`,
 * `conn:<slug>:<tool>`), scoped to who is asking: the front agent's grants (per thread: vault_grants is keyed by
 * thread) never cover a subagent, and a subagent's never cover the front agent or another subagent.
 */
export function grantKeyFor(identity: VaultIdentity, base: string): string {
  return identity.role === 'child' ? `sa:${identity.subagentId ?? 'unknown'}:${base}` : `front:${base}`;
}
