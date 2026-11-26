/**
 * Interactivity registry. Feature modules register handlers by action_id prefix (e.g. 'send:', 'report:',
 * 'card:stop_all', 'fact:'); the slack-events worker dispatches block_actions / view events here.
 * action_id convention: `<prefix>:<verb>`; put ids in the button `value`.
 */
export interface ActionContext {
  userId: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  actionId: string;
  value?: string;
  responseUrl?: string;
  triggerId?: string;
  body: any;
}
type ActionHandler = (ctx: ActionContext) => Promise<void>;
type AppHomeHandler = (userId: string) => Promise<void>;

const actionHandlers: [string, ActionHandler][] = [];
let appHomeHandler: AppHomeHandler | undefined;

export function registerAction(prefix: string, handler: ActionHandler) {
  actionHandlers.push([prefix, handler]);
}

export function findActionHandler(actionId: string): ActionHandler | undefined {
  return actionHandlers.find(([p]) => actionId.startsWith(p))?.[1];
}

export function registerAppHome(handler: AppHomeHandler) {
  appHomeHandler = handler;
}

export function getAppHomeHandler() {
  return appHomeHandler;
}

/**
 * Modal refreshers by callback_id prefix: after a block action inside a modal with a matching callback_id is handled,
 * the dispatcher calls the refresher (e.g. App Home's "View all" lists re-render after a Delete inside them).
 */
type ViewRefresher = (ctx: ActionContext) => Promise<void>;
const viewRefreshers: [string, ViewRefresher][] = [];

export function registerViewRefresher(callbackPrefix: string, fn: ViewRefresher) {
  viewRefreshers.push([callbackPrefix, fn]);
}

export function findViewRefresher(callbackId: string | undefined): ViewRefresher | undefined {
  if (!callbackId) return undefined;
  return viewRefreshers.find(([p]) => callbackId.startsWith(p))?.[1];
}
