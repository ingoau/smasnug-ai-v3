import { sql } from '../db/index.js';

/** Append to the per-thread event log. Context, cards, traces and replays are derived from it. */
export async function appendEvent(threadId: string, type: string, actor: string | null, payload: object = {}) {
  await sql`insert into thread_events (thread_id, type, actor, payload) values (${threadId}, ${type}, ${actor}, ${sql.json(payload as any)})`;
}

export function threadIdOf(channelId: string, threadTs: string) {
  return `${channelId}:${threadTs}`;
}

export function parseThreadId(threadId: string) {
  const i = threadId.indexOf(':');
  return { channelId: threadId.slice(0, i), threadTs: threadId.slice(i + 1) };
}

/**
 * The thread ts of a code channel's top-level conversation (docs/code-channels.md, "Inside the channel"). `0` can't
 * collide with a real message ts, so Slack threads under any message in the channel keep their own ids.
 */
export const CODE_CHANNEL_ROOT_TS = '0';

/** A code channel's top-level conversation: `${channel}:0`. */
export function codeChannelThreadId(channelId: string) {
  return threadIdOf(channelId, CODE_CHANNEL_ROOT_TS);
}

/** True for a thread id (or thread ts) of a code channel's top-level conversation. */
export function isCodeChannelRoot(threadTs: string) {
  return threadTs === CODE_CHANNEL_ROOT_TS;
}

/**
 * The `thread_ts` to send Slack for a stored thread ts: undefined (post top level, omit the arg) for a code channel's
 * conversation root `0`, else the ts itself. Every place that turns a thread id back into a Slack `thread_ts` goes
 * through this.
 */
export function slackThreadTs(threadTs: string | undefined | null): string | undefined {
  if (threadTs == null || threadTs === '' || isCodeChannelRoot(threadTs)) return undefined;
  return threadTs;
}

/** `{ thread_ts }` to spread into Slack args, or `{}` when the call must omit it (a code channel's root). */
export function threadTsArg(threadTs: string | undefined | null): { thread_ts?: string } {
  const ts = slackThreadTs(threadTs);
  return ts === undefined ? {} : { thread_ts: ts };
}

export function shortId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
