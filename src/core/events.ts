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

export function shortId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
