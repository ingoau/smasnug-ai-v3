/** Pure helpers for code channels: session ids, display names, privacy (docs/code-channels.md, Opening one). */
import { createHash } from 'node:crypto';

/**
 * What triggered a channel, for its `session_id`. Slack's `agents.conversations.create` is idempotent on it, so a
 * retried turn or a repeated press of the same button gets the same channel back.
 * - `tool`: `open_code_channel` in a front turn; `n` is the call's ordinal among that turn's open_code_channel calls
 *   (not the model's tool-call id, which a retried turn doesn't reproduce).
 * - `button`: a press of a `move_to_code_channel` button: the reply_buttons row and the button's index on it.
 * - `adopt`: a channel created from Slack's own UI, adopted by the bot.
 */
export type SessionSource =
  | { via: 'tool'; turnId: string; n?: number }
  | { via: 'button'; replyButtonsId: string; index: number }
  | { via: 'adopt'; channelId: string };

/** Slack's limit for `session_id`. */
export const SESSION_ID_MAX = 64;

function sourceKey(s: SessionSource): string {
  switch (s.via) {
    case 'tool':
      return `tool:${s.turnId}:${s.n ?? 0}`;
    case 'button':
      return `button:${s.replyButtonsId}:${s.index}`;
    case 'adopt':
      return `adopt:${s.channelId}`;
  }
}

/** Deterministic `session_id` (`smasnug-<via>-<32 hex>`, ≤ 64 chars) for a trigger. */
export function deriveSessionId(source: SessionSource): string {
  const hash = createHash('sha256').update(sourceKey(source)).digest('hex').slice(0, 32);
  return `smasnug-${source.via}-${hash}`;
}

/** Slack's limit for a channel / session display name. */
export const NAME_MAX = 200;

/**
 * "<bot name>: <name>" (e.g. "smasnug ai: fix the login bug"), whitespace collapsed and capped to Slack's 200
 * characters. An empty name falls back to "<bot name>: session".
 */
export function codeChannelDisplayName(name: string, botName: string): string {
  const clean = name.replace(/\s+/g, ' ').trim() || 'session';
  const full = `${botName}: ${clean}`;
  return [...full].length <= NAME_MAX ? full : [...full].slice(0, NAME_MAX - 1).join('') + '…';
}

/**
 * The `is_private` to send: `true` for a DM origin or an explicit `private: true`, else undefined (omitted, so
 * privacy follows the origin, or Slack's default when there is no origin link).
 */
export function resolveIsPrivate(opts: { originIsDm: boolean; private?: boolean }): true | undefined {
  return opts.originIsDm || opts.private === true ? true : undefined;
}
