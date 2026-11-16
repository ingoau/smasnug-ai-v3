/**
 * Typed wrappers over `slackCall` for the code-channel methods (docs/code-channels.md, Slack API). Every failure is
 * thrown as a CodeChannelError (errors.ts) with a message fit for people. Bot token only.
 *
 * Idempotency: `create` is sent unkeyed; Slack is idempotent on its session_id. `archive` takes a key from the
 * caller (a channel can be archived, reopened and archived again). setView / setCommands / rename / removeView are
 * upserts or replacements at Slack, so they're sent unkeyed unless the caller passes a key.
 */
import { slackCall } from '../../core/slack.js';
import { type CodeChannelMethod, CodeChannelError, codeChannelInputError, toCodeChannelError } from './errors.js';

async function call<T>(method: CodeChannelMethod, args: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  try {
    return await slackCall<any>(method, args, idempotencyKey ? { idempotencyKey } : {});
  } catch (err) {
    throw toCodeChannelError(method, err);
  }
}

export interface CreateArgs {
  /** Display name (1–200; Slack makes it unique). See codeChannelDisplayName. */
  name: string;
  /** deriveSessionId(...) of the trigger. */
  sessionId: string;
  /** `true` to force private; omit to follow the origin (resolveIsPrivate). */
  isPrivate?: true;
  /** The origin message: Slack invites its author and lets the origin's members join. */
  origin?: { channelId: string; ts: string };
}

/** agents.conversations.create → the new (or, for a repeated session_id, the same) channel id. */
export async function createCodeChannel(a: CreateArgs): Promise<{ channelId: string }> {
  const res = await call<{ channel_id?: string; channelId?: string }>(
    'agents.conversations.create',
    {
      name: a.name,
      session_id: a.sessionId,
      ...(a.isPrivate ? { is_private: true } : {}),
      ...(a.origin ? { origin_channel_id: a.origin.channelId, origin_message_ts: a.origin.ts } : {}),
    },
    // No idempotency key: Slack is idempotent on session_id (a repeat returns the same channel), while a claimed key
    // whose first call never finished (the worker died) would answer every retry with `{ skipped: true }` and no id.
  );
  const channelId = res.channel_id ?? res.channelId;
  if (!channelId) throw toCodeChannelError('agents.conversations.create', { data: { error: 'channel_creation_failed' } });
  return { channelId };
}

/**
 * agents.conversations.archive. `already_archived` is not an error: `{ alreadyArchived: true }`.
 * `idempotencyKey`: derived from the trigger (e.g. the closing summary's ts, or the /archive invocation).
 */
export async function archiveCodeChannel(a: { channelId: string; summaryMessageTs?: string; idempotencyKey: string }): Promise<{ alreadyArchived: boolean }> {
  try {
    await call(
      'agents.conversations.archive',
      { channel_id: a.channelId, ...(a.summaryMessageTs ? { summary_message_ts: a.summaryMessageTs } : {}) },
      `code-channel-archive:${a.idempotencyKey}`,
    );
    return { alreadyArchived: false };
  } catch (err) {
    if (err instanceof CodeChannelError && err.slackError === 'already_archived') return { alreadyArchived: true };
    throw err;
  }
}

/** One tab. `viewKey` is the upsert key (1–256); `name` the tab label. A channel holds ≤ 10 views (≤ 1 diff). */
export type CodeChannelView =
  | { type: 'html'; viewKey: string; name?: string; content: string; resourceDomains?: string[] }
  | { type: 'diff'; name?: string; content: string }
  | { type: 'block_kit'; viewKey: string; name?: string; blocks: unknown[] }
  | { type: 'canvas'; viewKey: string; name?: string; canvasId: string; accessLevel: 'read' | 'write' | 'comment' };

/** Max HTML / diff content (1 MB), checked before sending. */
export const VIEW_CONTENT_MAX_BYTES = 1_000_000;
/** Max `csp.resource_domains`. */
export const VIEW_RESOURCE_DOMAINS_MAX = 20;

/** The setView args for a view (pure; exported for tests). Throws a `bad_request` CodeChannelError on bad input. */
export function setViewArgs(channelId: string, v: CodeChannelView): Record<string, unknown> {
  const bad = (msg: string) => codeChannelInputError('agents.conversations.setView', msg);
  const args: Record<string, unknown> = { channel_id: channelId, type: v.type, ...(v.name ? { name: v.name } : {}) };
  if (v.type !== 'diff') {
    if (v.viewKey.length < 1 || v.viewKey.length > 256) throw bad('A tab key must be 1–256 characters.');
    args.view_key = v.viewKey;
  }
  if (v.type === 'html' || v.type === 'diff') {
    if (Buffer.byteLength(v.content, 'utf8') > VIEW_CONTENT_MAX_BYTES) throw bad('That tab is over Slack’s 1 MB limit.');
    args.content = v.content;
  }
  if (v.type === 'html' && v.resourceDomains?.length) {
    if (v.resourceDomains.length > VIEW_RESOURCE_DOMAINS_MAX) throw bad(`A tab can load from at most ${VIEW_RESOURCE_DOMAINS_MAX} domains.`);
    if (v.resourceDomains.some((d) => !/^https:\/\/[^/\s]+$/.test(d))) throw bad('Tab resource domains must be https origins (https://host).');
    args.csp = { resource_domains: v.resourceDomains };
  }
  if (v.type === 'block_kit') args.blocks = v.blocks;
  if (v.type === 'canvas') {
    args.canvas_id = v.canvasId;
    args.access_level = v.accessLevel;
  }
  return args;
}

/** agents.conversations.setView (upsert by view_key). */
export async function setCodeChannelView(channelId: string, view: CodeChannelView, idempotencyKey?: string): Promise<void> {
  await call('agents.conversations.setView', setViewArgs(channelId, view), idempotencyKey);
}

/** A tab as listViews returns it (shape assumed from the partner docs; unknown fields are kept). */
export interface CodeChannelViewInfo {
  view_key?: string;
  type?: string;
  name?: string;
  [k: string]: unknown;
}

/** agents.conversations.listViews. */
export async function listCodeChannelViews(channelId: string): Promise<CodeChannelViewInfo[]> {
  const res = await call<{ views?: CodeChannelViewInfo[] }>('agents.conversations.listViews', { channel_id: channelId });
  return res.views ?? [];
}

/** agents.conversations.removeView. */
export async function removeCodeChannelView(channelId: string, viewKey: string, idempotencyKey?: string): Promise<void> {
  await call('agents.conversations.removeView', { channel_id: channelId, view_key: viewKey }, idempotencyKey);
}

export interface CodeChannelCommand {
  /** 1–31, no leading slash. */
  name: string;
  /** 1–100. */
  description: string;
  /** ≤ 50. */
  argumentHint?: string;
  shouldEscape?: boolean;
}

/** The setCommands `commands` array (pure; exported for tests). */
export function commandsArg(commands: CodeChannelCommand[]): Record<string, unknown>[] {
  return commands.map((c) => ({
    name: c.name.replace(/^\//, ''),
    description: c.description,
    ...(c.argumentHint ? { argument_hint: c.argumentHint } : {}),
    ...(c.shouldEscape !== undefined ? { should_escape: c.shouldEscape } : {}),
  }));
}

/** agents.conversations.setCommands: replaces the bot's whole command set for the channel. */
export async function setCodeChannelCommands(channelId: string, commands: CodeChannelCommand[], idempotencyKey?: string): Promise<void> {
  await call('agents.conversations.setCommands', { channel_id: channelId, commands: commandsArg(commands) }, idempotencyKey);
}

/** agents.sessions.rename: renames the session and the channel (1–200). No thread_ts in a code channel. */
export async function renameCodeChannel(channelId: string, title: string, idempotencyKey?: string): Promise<void> {
  await call('agents.sessions.rename', { channel_id: channelId, title }, idempotencyKey);
}
