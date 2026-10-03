/** Interactivity dispatch: block_actions, view_submission, shortcuts, slash commands, App Home. */
import { findActionHandler, getAppHomeHandler, type ActionContext } from '../core/actions.js';
import { log } from '../log.js';
import { guardEntry } from './entry.js';

async function dispatch(ctx: ActionContext) {
  const handler = findActionHandler(ctx.actionId);
  if (!handler) {
    log.warn({ actionId: ctx.actionId }, 'no handler for interaction');
    return;
  }
  // Channel disable only gates conversation turns (or `/smasnug on` couldn't re-enable a channel); clicks don't
  // spend the messages/hour budget.
  const entry = await guardEntry(ctx.userId, undefined, { countMessage: false, allowSuspended: ctx.actionId.startsWith('mem:') });
  if (!entry.ok) return;
  try {
    await handler(ctx);
  } catch (err) {
    log.error({ err, actionId: ctx.actionId, userId: ctx.userId }, 'interaction handler failed');
  }
}

export async function handleInteractive(body: any) {
  const userId: string | undefined = body?.user?.id;
  if (!userId) return;
  switch (body.type) {
    case 'block_actions': {
      const channelId = body.channel?.id ?? body.container?.channel_id;
      const messageTs = body.message?.ts ?? body.container?.message_ts;
      const threadTs = body.message?.thread_ts ?? body.container?.thread_ts;
      for (const action of body.actions ?? []) {
        await dispatch({
          userId,
          channelId,
          messageTs,
          threadTs,
          actionId: action.action_id,
          value: action.value ?? action.selected_option?.value ?? action.selected_user ?? action.selected_channel,
          responseUrl: body.response_url,
          triggerId: body.trigger_id,
          body,
        });
      }
      return;
    }
    case 'view_submission':
    case 'view_closed': {
      const callbackId: string | undefined = body.view?.callback_id;
      if (!callbackId) return;
      await dispatch({
        userId,
        actionId: callbackId,
        value: body.view?.private_metadata,
        responseUrl: body.response_urls?.[0]?.response_url,
        triggerId: body.trigger_id,
        body,
      });
      return;
    }
    case 'shortcut':
    case 'message_action': {
      // Registered as 'shortcut:<callback_id>'.
      await dispatch({
        userId,
        channelId: body.channel?.id,
        messageTs: body.message?.ts,
        threadTs: body.message?.thread_ts,
        actionId: `shortcut:${body.callback_id}`,
        responseUrl: body.response_url,
        triggerId: body.trigger_id,
        body,
      });
      return;
    }
    default:
      log.debug({ type: body.type }, 'ignoring interactive payload');
  }
}

export async function handleSlash(body: any) {
  if (!body?.user_id || !body?.command) return;
  await dispatch({
    userId: body.user_id,
    channelId: body.channel_id,
    actionId: `slash:${body.command}`,
    value: body.text ?? '',
    responseUrl: body.response_url,
    triggerId: body.trigger_id,
    body,
  });
}

export async function handleAppHomeOpened(event: any) {
  if (event?.tab !== 'home' || !event.user) return;
  const handler = getAppHomeHandler();
  if (!handler) return;
  const entry = await guardEntry(event.user, undefined, { countMessage: false, allowSuspended: true });
  if (!entry.ok && entry.reason !== 'rate_limited') return; // viewing Home shouldn't be rate-limited away
  try {
    await handler(event.user);
  } catch (err) {
    log.error({ err, userId: event.user }, 'app home handler failed');
  }
}
