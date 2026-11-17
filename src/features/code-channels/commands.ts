/**
 * The bot's slash commands in code channels (docs/code-channels.md, Slash commands): registered per channel with
 * agents.conversations.setCommands when a channel is created (open.ts) or adopted (adopt.ts). Invocations arrive as
 * ordinary slash payloads (`slash:/archive`, `slash:/rename`, handled in lifecycle.ts).
 */
import { slackErrorCode } from '../../core/slack.js';
import { log } from '../../log.js';
import { setCodeChannelCommands, type CodeChannelCommand } from './api.js';
import { CodeChannelError } from './errors.js';

/** The bot's commands in every code channel (registered on create and adoption). */
export const CODE_CHANNEL_COMMANDS: CodeChannelCommand[] = [
  { name: 'archive', description: 'Post a closing summary and archive this channel' },
  { name: 'rename', description: 'Rename this session and channel', argumentHint: '<new title>' },
];

/** setCommands for a channel. Never throws: a failure is logged and returned as a problem string. */
export async function registerCodeChannelCommands(channelId: string): Promise<string | null> {
  try {
    await setCodeChannelCommands(channelId, CODE_CHANNEL_COMMANDS, `cc-commands:${channelId}`);
    return null;
  } catch (err) {
    log.warn({ err, channelId }, 'code channel setCommands failed');
    return `registering /archive and /rename failed (${err instanceof CodeChannelError ? err.slackError : (slackErrorCode(err) ?? 'error')})`;
  }
}

