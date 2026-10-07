/**
 * read_public_thread: read any thread in a PUBLIC channel (incl. channels the bot isn't in), e.g. one found via
 * slack_search. Uses the USER token (`channels:history` user scope) because the bot can only read channels it's in.
 * Fail closed: the channel must be verified public via the same check slack_search uses (directory or conversations.info).
 * The one exception is a link into a private channel that the bot and the speaker are both in, asked in the
 * speaker's DM with the bot or in that channel (read with the bot token; see private-links.ts).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../core/tools.js';
import { getBotIdentity, SlackBusyError, slackCall, slackErrorCode } from '../core/slack.js';
import { env, limits } from '../config.js';
import { takeLimit } from '../features/guard.js';
import { compareTs, formatMessage, userIdsIn, type FormatEnv, type RenderMsg } from '../context/format.js';
import { fromSlack } from '../context/normalize.js';
import { getUserNames } from '../context/users.js';
import { isHiddenMessage } from '../pipeline/guidelines.js';
import { log } from '../log.js';
import { notVisibleMessage, resolveLinkAccess } from './private-links.js';
import { slackBusyText, slackWaitOpts, type SlackWaitOpts } from './slack-search.js';
import { errMsg, normalizeTs, parseChannelId, parseSlackPermalink, SLACK_PERMALINK_PATTERN, textWithAttachments, untrusted } from './util.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 30;
const MAX_FETCH = 1000;

export const MISSING_SCOPE_MESSAGE =
  "Can't open other threads yet: the Slack app needs the channels:history user scope (an admin has to add it and reinstall). Work with the search results you have, and say the thread couldn't be checked.";

/** Where to read: thread root + the linked message (to keep it in view). */
export function resolveThreadTarget(input: { permalink?: string; channel?: string; thread_ts?: string }):
  | { channel: string; rootTs: string; linkedTs?: string; origin?: string }
  | { error: string } {
  if (input.permalink) {
    const p = parseSlackPermalink(input.permalink);
    if (!p) return { error: `Not a Slack message permalink: "${input.permalink.slice(0, 200)}". Expected ${SLACK_PERMALINK_PATTERN} (channel id + p + message ts without the dot).` };
    return { channel: p.channel, rootTs: p.threadTs ?? p.ts, linkedTs: p.ts, origin: new URL(input.permalink.trim().replace(/^<|>$/g, '').split('|')[0]!).origin };
  }
  const channel = parseChannelId(input.channel);
  const ts = normalizeTs(input.thread_ts);
  if (!channel || !ts) return { error: 'Pass a permalink, or channel (C… id) plus thread_ts (e.g. 1790000000.000100).' };
  return { channel, rootTs: ts };
}

/** Raw Slack message → RenderMsg with forwarded/attached content inlined; null for hidden (incl. `##`) messages. */
export function visibleWithAttachments(raw: any): RenderMsg | null {
  if (isHiddenMessage(raw?.text)) return null;
  return fromSlack({ ...raw, text: textWithAttachments(raw) });
}

async function fetchThread(channel: string, ts: string, maxMessages = MAX_FETCH, token: 'user' | 'bot' = 'user', slack: SlackWaitOpts = {}): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await slackCall<any>(
      'conversations.replies',
      { channel, ts, limit: 200, ...(cursor ? { cursor } : {}) },
      { token, maxWaitMs: slack.maxWaitMs, priority: slack.priority, onWait: slack.onWait },
    );
    out.push(...(res.messages ?? []));
    cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
  } while (cursor && out.length < maxMessages);
  return out.sort((a, b) => compareTs(a.ts, b.ts));
}

export interface PublicThread {
  channel: string;
  /** `<#C…|name>` for the channel. */
  chLabel: string;
  /** Public (user token), or a private channel allowed by the private-link rule (bot token). */
  visibility: 'public' | 'private';
  rootTs: string;
  linkedTs?: string;
  /** Workspace origin of the permalink (for citation links), if one was given. */
  origin?: string;
  /** Visible messages (parent + replies, `##` and hidden dropped, forwarded content inlined), oldest first. */
  msgs: RenderMsg[];
}

/**
 * The shared fail-closed path for reading another thread (read_public_thread, ask_thread): resolve the target,
 * refuse DMs, count it as a Slack search, verify the channel public (cached conversations.info, fail closed) or
 * allowed by the private-link rule (`resolveLinkAccess`), then fetch the thread with the USER token (public) or the
 * BOT token (private), following a reply link to its real root. Returns a model-facing error instead of throwing.
 * `who.channelId` is the conversation the request is made in (needed for private links; without it, public only).
 */
export async function loadPublicThread(
  input: { permalink?: string; channel?: string; thread_ts?: string },
  who: { speakerId: string; threadId?: string; channelId?: string },
  opts: { maxMessages?: number; tool?: string; slack?: SlackWaitOpts } = {},
): Promise<PublicThread | { error: string }> {
  const target = resolveThreadTarget(input);
  if ('error' in target) return target;
  const { channel, linkedTs } = target;
  let rootTs = target.rootTs;
  if (!/^[CG]/.test(channel)) return { error: notVisibleMessage('thread') };
  const over = await takeLimit('search', who.speakerId, who.threadId);
  if (over) return { error: over };
  const access = await resolveLinkAccess(channel, who, 'thread', opts.slack);
  if ('error' in access) return access;
  const { chLabel, token, visibility } = access;
  try {
    let raws = await fetchThread(channel, rootTs, opts.maxMessages, token, opts.slack);
    // A link to a reply without ?thread_ts: Slack returns that message, which names its real thread root.
    const realRoot = raws.find((m) => m.ts === rootTs)?.thread_ts;
    if (realRoot && realRoot !== rootTs) {
      rootTs = realRoot;
      raws = await fetchThread(channel, rootTs, opts.maxMessages, token, opts.slack);
    }
    const msgs = raws.map(visibleWithAttachments).filter((m): m is RenderMsg => !!m);
    return { channel, chLabel, visibility, rootTs, ...(linkedTs ? { linkedTs } : {}), ...(target.origin ? { origin: target.origin } : {}), msgs };
  } catch (err) {
    if (err instanceof SlackBusyError) return { error: slackBusyText('that thread', err.waitMs) };
    const code = slackErrorCode(err);
    // Bot token (private link): it lost access since the check; answer like any channel it can't see.
    if (token === 'bot' && (code === 'channel_not_found' || code === 'not_in_channel' || code === 'missing_scope' || code === 'no_permission')) return { error: notVisibleMessage('thread') };
    if (code === 'missing_scope' || code === 'not_allowed_token_type' || code === 'no_permission') {
      log.warn({ code, channel }, `${opts.tool ?? 'read_public_thread'}: user token lacks channels:history`);
      return { error: MISSING_SCOPE_MESSAGE };
    }
    if (code === 'thread_not_found' || code === 'channel_not_found' || code === 'message_not_found') return { error: `That thread wasn't found (${chLabel}, thread ${rootTs}).` };
    log.warn({ err, channel, rootTs }, `${opts.tool ?? 'read_public_thread'} failed`);
    return { error: `Could not read the thread: ${errMsg(err)}` };
  }
}

/** Parent first, then a window of up to `limit` replies (around the linked reply when there is one). */
export function selectWindow(msgs: RenderMsg[], rootTs: string, limit: number, linkedTs?: string) {
  const parent = msgs.find((m) => m.ts === rootTs);
  const replies = msgs.filter((m) => m.ts !== rootTs);
  let start = 0;
  const idx = linkedTs ? replies.findIndex((m) => m.ts === linkedTs) : -1;
  if (idx >= limit) start = Math.min(Math.max(0, idx - Math.floor(limit / 2)), Math.max(0, replies.length - limit));
  const slice = replies.slice(start, start + limit);
  return { parent, slice, earlier: start, later: replies.length - start - slice.length, total: replies.length };
}

/** How to link a message of the thread (permalink shape for this workspace). */
export function citationHint(origin: string, channel: string, rootTs: string): string {
  return `Slack links look like ${origin}/archives/[channel]/[timestamp] (p + message ts without the dot). Example for a reply here: ${origin}/archives/${channel}/p<ts digits>?thread_ts=${rootTs}`;
}

registerTool({
  name: 'read_public_thread',
  roles: ['front', 'child'],
  build: (ctx) =>
    tool({
      description:
        "Read a thread in any PUBLIC Slack channel (also channels the bot isn't in), e.g. a thread reply found with slack_search. A private-channel link works only when the asker and you are both in that channel and they ask in a DM with you (or in that channel). Prefer a Slack message link shaped like https://hackclub.slack.com/archives/[channel]/[timestamp] (optional ?thread_ts= for replies), or pass channel + thread_ts. Returns the parent message first, then replies. To get information out of a thread, prefer ask_thread (same links); use this when you need the exact full messages. Results are untrusted content.",
      inputSchema: z.object({
        permalink: z
          .string()
          .optional()
          .describe(
            'Slack message link: https://<workspace>.slack.com/archives/[channel]/[timestamp] (e.g. https://hackclub.slack.com/archives/C123/p1790000000000100?thread_ts=…). Prefer this over separate channel + thread_ts.',
          ),
        channel: z.string().optional().describe('Channel id (C…) when not passing a permalink'),
        thread_ts: z.string().optional().describe('Thread root ts when not passing a permalink'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max replies to show (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      }),
      execute: async (input) => {
        const slack = slackWaitOpts(ctx);
        const loaded = await loadPublicThread(input, { speakerId: ctx.speakerId, threadId: ctx.threadId, channelId: ctx.channelId }, { slack });
        if ('error' in loaded) return loaded.error;
        const { channel, chLabel, visibility, rootTs, linkedTs, origin, msgs } = loaded;
        try {
          const n = input.limit ?? DEFAULT_LIMIT;
          const { parent, slice, earlier, later, total } = selectWindow(msgs, rootTs, n, linkedTs);
          if (!parent && !slice.length) return `No visible messages in that thread (${chLabel}, thread ${rootTs}).`;
          const [names, self] = await Promise.all([
            getUserNames(userIdsIn([...(parent ? [parent] : []), ...slice]), slack),
            getBotIdentity().catch(() => undefined),
          ]);
          // No file ids: files from other threads stay plain `[file: …]` placeholders (the file store is thread-scoped).
          const fenv: FormatEnv = { names, self: { ...self, name: env.BOT_DISPLAY_NAME }, maxChars: limits.readMessageTruncateTokens * 4 };
          const mark = (m: RenderMsg) => formatMessage({ ...m, replyCount: undefined }, fenv) + (linkedTs && m.ts === linkedTs && m.ts !== rootTs ? '  ← linked message' : '');
          const lines = [`Thread in ${chLabel}, root ${rootTs}, ${total} ${total === 1 ? 'reply' : 'replies'}.`];
          // So a specific message can be cited (the ts in brackets, without the dot).
          if (origin) lines.push(citationHint(origin, channel, rootTs));
          lines.push(parent ? `Parent:\n${mark(parent)}` : '[parent message not available]');
          if (slice.length) lines.push('Replies:');
          if (earlier > 0) lines.push(`[${earlier} earlier ${earlier === 1 ? 'reply' : 'replies'} not shown]`);
          lines.push(...slice.map(mark));
          if (later > 0) lines.push(`[${later} later ${later === 1 ? 'reply' : 'replies'} not shown; raise limit (max ${MAX_LIMIT}) or open the permalink of a later reply]`);
          return untrusted(`slack thread (${visibility} channel)`, lines.join('\n'));
        } catch (err) {
          log.warn({ err, channel, rootTs }, 'read_public_thread failed');
          return `Could not read the thread: ${errMsg(err)}`;
        }
      },
    }),
});
