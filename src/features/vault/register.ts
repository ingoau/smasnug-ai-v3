/** Vault wiring (docs/vault.md): tools, approval buttons, App Home modal, maintenance. Inert without VAULT_SECRET_KEY. */
import { registerAction, type ActionContext } from '../../core/actions.js';
import { APPROVE_ONCE, APPROVE_WINDOW, DENY, expireApprovals, handleApprovalAction } from './approvals.js';
import { pruneAudit } from './audit.js';
import { vaultConfigured } from './crypto.js';
import { handleVaultHomeAction, handleVaultModal, VAULT_MODAL_CALLBACK } from './home.js';
import { registerVaultTools } from './tools.js';

type PublishHome = (userId: string) => Promise<void>;

export function registerVault(publishHome: PublishHome): void {
  registerVaultTools();
  // Approvals first (first matching prefix wins), then the rest of vault:.
  for (const id of [APPROVE_ONCE, APPROVE_WINDOW, DENY]) registerAction(id, handleApprovalAction);
  registerAction('vault:', (ctx: ActionContext) => handleVaultHomeAction(ctx, publishHome));
  registerAction(VAULT_MODAL_CALLBACK, (ctx: ActionContext) => handleVaultModal(ctx, publishHome));
}

export const vaultMaintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = vaultConfigured()
  ? {
      'vault:approval-expiry': { everyMs: 30 * 1000, run: expireApprovals },
      'vault:prune': { everyMs: 6 * 60 * 60 * 1000, run: pruneAudit },
    }
  : {};
