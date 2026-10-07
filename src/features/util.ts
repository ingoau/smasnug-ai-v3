/** Small helpers shared by the features module. */
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { parseThreadId } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { fakeCall } from '../core/slack-fake.js';
import { log } from '../log.js';
import { rememberSlackUser } from '../tools/directory/store.js';

export function isAdmin(userId: string | undefined): boolean {
  return !!userId && !!env.ADMIN_USER_ID && userId === env.ADMIN_USER_ID;
}

/**
 * POST to an interaction's response_url (replace/delete the source message, or reply ephemerally).
 * Not a Web API method, so it does not go through slackCall's rate limiter; with SLACK_FAKE it is recorded as
 * the pseudo-method `response_url`.
 */
export async function respond(responseUrl: string | undefined, payload: Record<string, unknown>): Promise<boolean> {
  if (!responseUrl) return false;
  if (process.env.SLACK_FAKE === '1') {
    await fakeCall('response_url', { url: responseUrl, ...payload }, 'bot');
    return true;
  }
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn({ status: res.status }, 'response_url post failed');
    return res.ok;
  } catch (err) {
    log.warn({ err }, 'response_url post failed');
    return false;
  }
}

/**
 * Reply to the clicking user only. A click in a thread (`opts.threadTs`, else the clicked message's thread) is
 * answered with chat.postEphemeral in that thread: response_url posts (new ephemerals, and replacements of an
 * ephemeral message) land at the channel / DM root. `replace` there: an ephemeral source message is removed
 * (delete_original) and the text posted in the thread; a regular message is still replaced in place. Outside a
 * thread: response_url, else chat.postEphemeral.
 */
export async function ephemeral(ctx: ActionContext, text: string, opts: { replace?: boolean; threadTs?: string } = {}) {
  // A click on a thread's parent message (thread_ts = its own ts) stays a root-level answer.
  const threadTs = opts.threadTs ?? (ctx.threadTs && ctx.threadTs !== ctx.messageTs ? ctx.threadTs : undefined);
  if (ctx.channelId && threadTs) {
    if (opts.replace) {
      if (isEphemeralSource(ctx)) await deleteOriginal(ctx);
      else if (await respond(ctx.responseUrl, { replace_original: true, text })) return;
    }
    await slackCall('chat.postEphemeral', { channel: ctx.channelId, user: ctx.userId, text, thread_ts: threadTs }).catch((err) =>
      log.warn({ err }, 'ephemeral in thread failed'),
    );
    return;
  }
  const payload = opts.replace
    ? { replace_original: true, text }
    : { response_type: 'ephemeral', replace_original: false, text };
  if (await respond(ctx.responseUrl, payload)) return;
  if (ctx.channelId) {
    await slackCall('chat.postEphemeral', {
      channel: ctx.channelId,
      user: ctx.userId,
      text,
      ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
    }).catch((err) => log.warn({ err }, 'ephemeral fallback failed'));
  }
}

/**
 * Remove the message the clicked button sits on (e.g. an ephemeral preview) via response_url: `delete_original` as
 * the sole attribute; works for ephemeral messages, within 30 minutes / 5 responses of the click.
 * https://docs.slack.dev/interactivity/handling-user-interaction (no Web API method can delete an ephemeral message).
 * Returns false when there is no response_url or the post failed (the caller may replace it instead).
 */
export async function deleteOriginal(ctx: ActionContext): Promise<boolean> {
  return respond(ctx.responseUrl, { delete_original: true });
}

/**
 * The interaction with its thread filled in from a row that knows it (a pending send's / launch's thread): a button on
 * an ephemeral message may not carry its thread, and ephemeral() then answers in that thread, not at the root.
 */
export function withThread(ctx: ActionContext, threadId: string | null | undefined): ActionContext {
  if (!threadId || (ctx.threadTs && ctx.threadTs !== ctx.messageTs)) return ctx;
  const { channelId, threadTs } = parseThreadId(threadId);
  if (ctx.channelId && ctx.channelId !== channelId) return ctx;
  return { ...ctx, channelId, threadTs };
}

/** The clicked button sits on an ephemeral message (Slack marks its container). */
export function isEphemeralSource(ctx: Pick<ActionContext, 'body'>): boolean {
  return ctx.body?.container?.is_ephemeral === true;
}

export interface UserProfile {
  id: string;
  name: string;
  avatar?: string;
}

const profileCache = new Map<string, { at: number; profile: UserProfile }>();
const PROFILE_TTL_MS = 10 * 60 * 1000;

export async function userProfile(userId: string): Promise<UserProfile> {
  const hit = profileCache.get(userId);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  try {
    const res = await slackCall<any>('users.info', { user: userId });
    await rememberSlackUser(res.user); // the directory is the one profile store (write-through)
    const u = res.user ?? {};
    const p = u.profile ?? {};
    const profile: UserProfile = {
      id: userId,
      name: p.display_name || p.real_name || u.real_name || u.name || userId,
      avatar: p.image_192 || p.image_72 || p.image_48,
    };
    profileCache.set(userId, { at: Date.now(), profile });
    return profile;
  } catch (err) {
    log.warn({ err, userId }, 'users.info failed');
    return { id: userId, name: userId };
  }
}

/** Post to the moderation channel. Returns the message ts, or undefined if no mod channel is configured. */
export async function postToModChannel(text: string, blocks: unknown[], idempotencyKey: string, threadTs?: string) {
  if (!env.MOD_CHANNEL_ID) {
    log.warn({ text }, 'MOD_CHANNEL_ID not set; moderation message not posted');
    return undefined;
  }
  const res = await slackCall<any>(
    'chat.postMessage',
    { channel: env.MOD_CHANNEL_ID, text, blocks, unfurl_links: false, ...(threadTs ? { thread_ts: threadTs } : {}) },
    { idempotencyKey },
  );
  return res.ts as string | undefined;
}

/** Escape text for Slack mrkdwn (section/context blocks). */
export function mrkdwnEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Quote text for a mrkdwn section (escaped, every line prefixed with `>`). */
export function quote(s: string, max = 2500) {
  return truncate(mrkdwnEscape(s), max)
    .split('\n')
    .map((l) => `>${l}`)
    .join('\n');
}

/** Only the admin may run moderation actions; replies ephemerally and returns false otherwise. */
export async function requireAdmin(ctx: ActionContext): Promise<boolean> {
  if (isAdmin(ctx.userId)) return true;
  await ephemeral(ctx, 'Only the admin can do that.');
  return false;
}

/** True if the interaction came from the App Home tab. */
export function fromAppHome(ctx: ActionContext) {
  return ctx.body?.view?.type === 'home' || ctx.body?.container?.type === 'view';
}
