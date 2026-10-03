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
