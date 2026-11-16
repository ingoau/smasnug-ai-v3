/**
 * Slack errors from the code-channel methods (`agents.conversations.*`, `agents.sessions.rename`), mapped to typed
 * errors with a message the tool / button can show people as is. Pure: no Slack or database access.
 */

export type CodeChannelMethod =
  | 'agents.conversations.create'
  | 'agents.conversations.archive'
  | 'agents.conversations.setView'
  | 'agents.conversations.listViews'
  | 'agents.conversations.removeView'
  | 'agents.conversations.setCommands'
  | 'agents.sessions.rename';

/**
 * What went wrong, grouped by what the caller should do:
 * - `unavailable`: code channels can't be used here at all (create nothing, say so; no plain-channel fallback).
 * - `not_allowed`: a workspace setting or permission refuses this action.
 * - `bad_request`: our input (origin link, name, view content) was refused; another try with other input may work.
 * - `gone`: the channel is archived / not a code channel / not visible to the bot.
 * - `transient`: Slack failed; retrying later may work.
 * - `unknown`: anything else.
 */
export type CodeChannelErrorKind = 'unavailable' | 'not_allowed' | 'bad_request' | 'gone' | 'transient' | 'unknown';

interface Known {
  kind: CodeChannelErrorKind;
  message: string;
}

/** Known Slack error codes (partner docs, read 2026-11-16) plus the generic ones these methods can return. */
const KNOWN: Record<string, Known> = {
  feature_disabled: { kind: 'unavailable', message: "Code channels aren't available in this workspace yet, so I couldn't open one." },
  user_not_enabled: { kind: 'unavailable', message: "Code channels aren't enabled for your Slack account yet, so I couldn't open one." },
  missing_scope: { kind: 'unavailable', message: "I don't have Slack's permission to manage code channels here yet." },
  not_allowed_token_type: { kind: 'unavailable', message: "Code channels can't be managed with the token I have." },
  restricted_action: { kind: 'not_allowed', message: "This workspace's settings don't let me do that." },
  not_authorized: { kind: 'not_allowed', message: "I'm not allowed to do that in this channel." },
  file_editing_disabled: {
    kind: 'not_allowed',
    message: 'This organisation has turned off file editing, so HTML and Block Kit tabs are off. Canvas tabs still work.',
  },
  invalid_origin_link: { kind: 'bad_request', message: "I couldn't link the new channel to the message it came from (it may have been deleted)." },
  channel_not_viewable: { kind: 'bad_request', message: "I can't see the conversation the channel would be opened from." },
  name_taken: { kind: 'bad_request', message: 'That name is already taken. Try another one.' },
  invalid_name: { kind: 'bad_request', message: "Slack didn't accept that name. Try a shorter or simpler one." },
  invalid_arguments: { kind: 'bad_request', message: "Slack didn't accept that request." },
  invalid_blocks: { kind: 'bad_request', message: "Slack didn't accept those blocks." },
  thread_ts_not_allowed: { kind: 'bad_request', message: "Slack didn't accept that request." },
  too_many_views: { kind: 'bad_request', message: 'This channel already has the most tabs Slack allows (10). Remove one first.' },
  too_many_commands: { kind: 'bad_request', message: 'This channel already has the most slash commands Slack allows (10).' },
  already_archived: { kind: 'gone', message: 'That channel is already archived.' },
  is_archived: { kind: 'gone', message: 'That channel is archived.' },
  not_agent_channel: { kind: 'gone', message: "That isn't a code channel." },
  channel_not_found: { kind: 'gone', message: "I can't find that channel." },
  not_in_channel: { kind: 'gone', message: "I'm not in that channel." },
  channel_creation_failed: { kind: 'transient', message: "Slack couldn't create the channel. Try again in a bit." },
  invite_failed: { kind: 'transient', message: "Slack couldn't invite people to the new channel. Try again in a bit." },
  internal_error: { kind: 'transient', message: 'Slack had an internal error. Try again in a bit.' },
  fatal_error: { kind: 'transient', message: 'Slack had an internal error. Try again in a bit.' },
  service_unavailable: { kind: 'transient', message: "Slack isn't available right now. Try again in a bit." },
  request_timeout: { kind: 'transient', message: 'Slack took too long to answer. Try again in a bit.' },
};

export class CodeChannelError extends Error {
  readonly method: CodeChannelMethod;
  /** Slack's error code (`feature_disabled`, …), or `unknown` when the failure carried none (network, timeout). */
  readonly slackError: string;
  readonly kind: CodeChannelErrorKind;
  /** Safe to show people as is (no internals). */
  readonly userMessage: string;
  constructor(method: CodeChannelMethod, slackError: string, kind: CodeChannelErrorKind, userMessage: string, cause?: unknown) {
    super(`${method} failed: ${slackError}`, cause === undefined ? undefined : { cause });
    this.name = 'CodeChannelError';
    this.method = method;
    this.slackError = slackError;
    this.kind = kind;
    this.userMessage = userMessage;
  }
  /** Code channels can't be used here at all: report it and create nothing. */
  get unavailable(): boolean {
    return this.kind === 'unavailable';
  }
}

/** A thrown Slack call error → CodeChannelError (an existing CodeChannelError passes through). */
export function toCodeChannelError(method: CodeChannelMethod, err: unknown): CodeChannelError {
  if (err instanceof CodeChannelError) return err;
  // Read like core/slack.ts's slackErrorCode (not imported: this file stays free of Slack/Redis imports).
  const raw: unknown = (err as any)?.data?.error;
  const code = typeof raw === 'string' ? raw : undefined;
  if (!code) return new CodeChannelError(method, 'unknown', 'transient', "I couldn't reach Slack. Try again in a bit.", err);
  const known = KNOWN[code];
  if (known) return new CodeChannelError(method, code, known.kind, known.message, err);
  return new CodeChannelError(method, code, 'unknown', `Slack refused that (${code}).`, err);
}

/** Our own input check failed before calling Slack (`invalid_arguments`, kind `bad_request`). */
export function codeChannelInputError(method: CodeChannelMethod, userMessage: string): CodeChannelError {
  return new CodeChannelError(method, 'invalid_arguments', 'bad_request', userMessage);
}
