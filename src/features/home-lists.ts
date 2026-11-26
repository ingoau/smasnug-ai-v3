/**
 * App Home lists behind a dialog. Long lists (memories, workspace facts, credentials, reminders, blocked users, the
 * sandbox allowlist) show a count and a "View all" button on the Home tab; the button opens a modal with every item and
 * its usual buttons. A button inside the modal is handled by its normal action handler (they all refresh the Home tab),
 * then the dispatcher re-renders the modal (registerViewRefresher), so a deleted item disappears from it too.
 */
import type { ActionContext } from '../core/actions.js';
import { registerAction, registerViewRefresher } from '../core/actions.js';
import { slackCall } from '../core/slack.js';
import { log } from '../log.js';
import { isAdmin, requireAdmin, truncate } from './util.js';

export interface HomeList {
  /** [a-z_]+, unique. */
  key: string;
  /** Modal title (Slack allows 24 characters). */
  title: string;
  /** Admin-only list: only the admin can open it (and its items' buttons check again). */
  admin?: boolean;
  /** The modal's blocks: every item with its buttons. Lists cap themselves; anything past MODAL_MAX_BLOCKS is cut. */
  build(userId: string): Promise<unknown[]>;
}

export const HOME_LIST_OPEN = 'homelist:open';
const VIEW_PREFIX = 'homelistv:';
/** Slack's limit for a modal's blocks. */
export const MODAL_MAX_BLOCKS = 100;

const lists = new Map<string, HomeList>();

export function registerHomeList(list: HomeList): void {
  lists.set(list.key, list);
}

const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/** A closing note for a modal list that shows `shown` of `total` items. */
export function moreNote(total: number, shown: number): unknown[] {
  return total > shown ? [context(`…and ${total - shown} more not shown here.`)] : [];
}

function modal(list: HomeList, blocks: unknown[]) {
  const body = blocks.length ? blocks : [context('Nothing here.')];
  return {
    type: 'modal',
    callback_id: `${VIEW_PREFIX}${list.key}`,
    title: { type: 'plain_text', text: truncate(list.title, 24) },
    close: { type: 'plain_text', text: 'Done' },
    blocks: body.length > MODAL_MAX_BLOCKS ? [...body.slice(0, MODAL_MAX_BLOCKS - 1), context('Some items are not shown.')] : body,
  };
}

/**
 * The Home tab's part of a list: the items inline while there are at most `inlineMax` of them, otherwise `summary`
 * with a "View all" button that opens the dialog.
 */
export function homeListBlocks(o: { key: string; count: number; summary: string; inline?: () => unknown[]; inlineMax?: number; buttonText?: string }): unknown[] {
  if (o.count <= (o.inlineMax ?? 0) && o.inline) return o.inline();
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: o.summary },
      accessory: { type: 'button', action_id: HOME_LIST_OPEN, text: { type: 'plain_text', text: o.buttonText ?? `View all (${o.count})` }, value: o.key },
    },
  ];
}

/** The dialog for list `key` as `userId` sees it; null for an unknown list or a non-admin asking for an admin one. */
export async function homeListView(key: string, userId: string): Promise<object | null> {
  const list = lists.get(key);
  if (!list || (list.admin && !isAdmin(userId))) return null;
  return modal(list, await list.build(userId));
}

async function open(ctx: ActionContext): Promise<void> {
  const list = lists.get(ctx.value ?? '');
  if (!list || !ctx.triggerId) return;
  if (list.admin && !(await requireAdmin(ctx))) return;
  // Open at once (a trigger id lives 3 s and the click already waited in the queue), then fill it in.
  let viewId: string | undefined;
  try {
    const res = await slackCall<any>('views.open', { trigger_id: ctx.triggerId, view: modal(list, [context('Loading…')]) });
    viewId = res?.view?.id;
  } catch (err) {
    log.warn({ err, key: list.key }, 'home list modal open failed');
    await slackCall('chat.postMessage', { channel: ctx.userId, text: `Slack took too long to open “${list.title}”. Press the button in my App Home again.` }).catch(() => {});
    return;
  }
  const view = await homeListView(list.key, ctx.userId);
  if (viewId && view) await slackCall('views.update', { view_id: viewId, view }).catch((err) => log.warn({ err, key: list.key }, 'home list modal fill failed'));
}

async function refresh(ctx: ActionContext): Promise<void> {
  const v = ctx.body?.view;
  const key = String(v?.callback_id ?? '').slice(VIEW_PREFIX.length);
  const view = v?.id ? await homeListView(key, ctx.userId) : null;
  if (view) await slackCall('views.update', { view_id: v.id, view });
}

export function registerHomeListActions(): void {
  registerAction(HOME_LIST_OPEN, open);
  registerViewRefresher(VIEW_PREFIX, refresh);
}
