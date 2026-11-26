/**
 * MCP connectors wiring (docs/mcp-custom-connectors.md): App Home actions (`conn:`), modals (`connm:`), and the
 * prompt-mode approval executor. The tools themselves are loaded per turn by src/agent/front.ts
 * (loadConnectorTools). Inert without VAULT_SECRET_KEY or with an empty catalog.
 */
import { registerAction, type ActionContext } from '../../core/actions.js';
import { CONN_ACTION_PREFIX, CONN_MODAL_PREFIX, handleConnectorAction, handleConnectorModal } from './home.js';
import { registerConnectorExecutor } from './tools.js';

type PublishHome = (userId: string) => Promise<void>;

export function registerConnectors(publishHome: PublishHome): void {
  registerConnectorExecutor();
  registerAction(CONN_MODAL_PREFIX, (ctx: ActionContext) => handleConnectorModal(ctx, publishHome));
  registerAction(CONN_ACTION_PREFIX, (ctx: ActionContext) => handleConnectorAction(ctx, publishHome));
}
