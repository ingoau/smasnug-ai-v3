/** `/smasnug off|on|status` — per-channel disable for channel owners (creator) and the admin. */
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { slackCall } from '../core/slack.js';
import { log } from '../log.js';
import { getState, setChannelDisabled } from './state.js';
import { ephemeral, isAdmin } from './util.js';

export type SlashVerb = 'off' | 'on' | 'status' | 'help';

export function parseSlash(text: string | undefined): SlashVerb {
  const t = (text ?? '').trim().toLowerCase();
  if (['off', 'disable', 'stop', 'mute'].includes(t)) return 'off';
  if (['on', 'enable', 'start', 'unmute'].includes(t)) return 'on';
  if (t === '' || t === 'status') return 'status';
  return 'help';
}

async function channelCreator(channelId: string): Promise<{ creator?: string; isChannel: boolean }> {
  try {
    const res = await slackCall<any>('conversations.info', { channel: channelId });
    const c = res.channel ?? {};
    return { creator: c.creator, isChannel: !c.is_im && !c.is_mpim };
  } catch (err) {
    log.warn({ err, channelId }, 'conversations.info failed');
    return { isChannel: !channelId.startsWith('D') };
  }
}

export async function handleSlash(ctx: ActionContext) {
  const channelId: string | undefined = ctx.channelId ?? ctx.body?.channel_id;
  const text: string | undefined = ctx.body?.text ?? ctx.value;
  const verb = parseSlash(text);
  const cmd = ctx.body?.command ?? '/smasnug';
  const reply = (t: string) => ephemeral({ ...ctx, channelId }, t);

  if (verb === 'help' || !channelId) {
    return reply(
      `\`${cmd} off\` stops ${env.BOT_DISPLAY_NAME} from responding in this channel, \`${cmd} on\` turns it back on, ` +
        `\`${cmd} status\` shows the current state. Only the channel's creator (or the admin) can change it.`,
    );
  }

  const state = await getState();
  if (verb === 'status') {
    const disabled = state.disabledChannels.has(channelId);
    return reply(
      `${env.BOT_DISPLAY_NAME} is ${disabled ? '*off*' : '*on*'} in this channel.` +
        (state.paused ? ' The bot is also paused globally by the admin.' : ''),
    );
  }

  const { creator, isChannel } = await channelCreator(channelId);
  if (!isChannel) return reply('This only works in channels.');
  if (!isAdmin(ctx.userId) && creator !== ctx.userId)
    return reply(`Only the channel's creator${creator ? ` (<@${creator}>)` : ''} or the admin can turn ${env.BOT_DISPLAY_NAME} ${verb} here.`);

  await setChannelDisabled(channelId, verb === 'off');
  log.info({ channelId, by: ctx.userId, verb }, 'channel kill switch');
  return reply(
    verb === 'off'
      ? `${env.BOT_DISPLAY_NAME} is now off in this channel. \`${cmd} on\` turns it back on.`
      : `${env.BOT_DISPLAY_NAME} is back on in this channel.`,
  );
}
