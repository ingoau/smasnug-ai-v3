/**
 * Agent session status (Agents & AI Apps): `agents.sessions.setStatus`. `processing` shows "working" plus Slack's
 * native stop button; unlike the old `assistant.threads.setStatus` it does NOT clear when the bot posts, so every
 * `processing` must be followed by `active`. Best-effort: never throws.
 */
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';

export type SessionStatus = 'active' | 'processing' | 'suspended' | 'closed';

/** Legacy status text used by the `assistant.threads.setStatus` fallback. */
export const STATUS_TEXT = 'is thinking…';

/** Errors where the old method wouldn't help either (wrong place, not a member …): log at debug, no fallback. */
const EXPECTED_ERRORS = new Set(['channel_not_found', 'not_in_channel', 'thread_ts_not_allowed', 'method_not_supported_for_channel_type', 'is_archived']);

export async function setSessionStatus(channelId: string, threadTs: string, status: SessionStatus, initiatorUserId?: string): Promise<void> {
  try {
    await slackCall('agents.sessions.setStatus', {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
      ...(initiatorUserId ? { initiator_user_id: initiatorUserId } : {}),
    });
    return;
  } catch (err) {
    const code = slackErrorCode(err);
    if (code && EXPECTED_ERRORS.has(code)) {
      log.debug({ channelId, threadTs, status, code }, 'agents.sessions.setStatus not applicable here');
      return;
    }
    log.warn({ err, channelId, threadTs, status }, 'agents.sessions.setStatus failed; falling back to assistant.threads.setStatus');
  }
  // Fallback, once. The legacy method only knows a status text ('' clears it).
  if (status !== 'processing' && status !== 'active') return;
  try {
    await slackCall('assistant.threads.setStatus', { channel_id: channelId, thread_ts: threadTs, status: status === 'processing' ? STATUS_TEXT : '' });
  } catch (err) {
    if (slackErrorCode(err) === 'method_not_supported_for_channel_type') log.debug({ channelId }, 'assistant.threads.setStatus unsupported here');
    else log.warn({ err, channelId, threadTs }, 'assistant.threads.setStatus fallback failed');
  }
}
