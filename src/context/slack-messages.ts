/** Reading messages from Slack (bot token) and from the `messages` table, normalised to RenderMsg. */
import { sql } from '../db/index.js';
import { slackCall, type SlackCallOpts } from '../core/slack.js';
import { compareTs } from './format.js';
import { fromSlack } from './normalize.js';

export { fromSlack, fromStored } from './normalize.js';

/** Store messages we pulled from Slack. Never overwrites rows the pipeline already wrote (they may be newer). */
export async function storeMessages(channelId: string, threadId: string | null, raws: any[]) {
  const rows = raws
    .map((r) => ({ r, m: fromSlack(r) })) // null: joins/leaves, tombstones, `##` messages — never stored
    .filter((x): x is { r: any; m: NonNullable<ReturnType<typeof fromSlack>> } => x.m !== null)
    .map(({ r, m }) => {
      return {
        channel_id: channelId,
        ts: m.ts,
        thread_id: threadId,
        user_id: m.userId,
        bot_id: m.botId,
        username: m.username,
        text: m.text,
        files: sql.json(m.files as any),
        edited_at: r.edited?.ts ? new Date(Number(r.edited.ts) * 1000) : null,
        reactions: sql.json((m.reactions ?? []) as any),
        attachments: sql.json((m.attachments ?? []) as any),
      };
    });
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await sql`insert into messages ${sql(chunk, 'channel_id', 'ts', 'thread_id', 'user_id', 'bot_id', 'username', 'text', 'files', 'edited_at', 'reactions', 'attachments')}
      on conflict (channel_id, ts) do nothing`;
  }
}

/** conversations.replies for a whole thread (oldest first), paginated up to `maxMessages`. */
export async function fetchReplies(
  channelId: string,
  threadTs: string,
  opts: { latest?: string; maxMessages?: number; slack?: Pick<SlackCallOpts, 'maxWaitMs' | 'priority' | 'onWait'> } = {},
): Promise<any[]> {
  const max = opts.maxMessages ?? 1000;
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await slackCall<any>(
      'conversations.replies',
      {
        channel: channelId,
        ts: threadTs,
        limit: 200,
        ...(opts.latest ? { latest: opts.latest, inclusive: false } : {}),
        ...(cursor ? { cursor } : {}),
      },
      opts.slack ?? {},
    );
    out.push(...(res.messages ?? []));
    cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
  } while (cursor && out.length < max);
  // Slack includes the parent even when `latest` excludes it; enforce the bound ourselves.
  const bounded = opts.latest ? out.filter((m) => m.ts === threadTs || compareTs(m.ts, opts.latest!) < 0) : out;
  return bounded.sort((a, b) => compareTs(a.ts, b.ts));
}

/** conversations.history: up to `limit` top-level messages strictly before `latest` (oldest first). */
export async function fetchHistoryBefore(channelId: string, opts: { latest?: string; limit: number }): Promise<any[]> {
  const res = await slackCall<any>('conversations.history', {
    channel: channelId,
    limit: opts.limit,
    ...(opts.latest ? { latest: opts.latest, inclusive: false } : {}),
  });
  return [...(res.messages ?? [])].sort((a, b) => compareTs(a.ts, b.ts));
}

/** conversations.history: the first `limit` top-level messages after `oldest` (within `windowS`), oldest first. */
export async function fetchHistoryAfter(channelId: string, oldest: string, limit: number, windowS = 6 * 3600): Promise<any[]> {
  const latest = (Number(oldest.split('.')[0]) + windowS).toString() + '.000000';
  const res = await slackCall<any>('conversations.history', { channel: channelId, oldest, latest, inclusive: false, limit: 100 });
  return [...(res.messages ?? [])].sort((a, b) => compareTs(a.ts, b.ts)).slice(0, limit);
}
