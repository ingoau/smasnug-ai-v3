/**
 * Extra blocks posted on a reply (table reply_charts: charts, images, tables, cards). Card and button re-renders
 * rebuild the message from DB state.
 */
import { sql } from '../db/index.js';
import { storedCharts } from './charts.js';
import { chartExtra, parseExtras, serializeExtras, type ReplyExtras } from './rich-blocks.js';

export async function saveReplyExtras(channelId: string, messageTs: string, extras: ReplyExtras | null | undefined): Promise<void> {
  if (!extras?.items.length) return;
  const charts = extras.items.filter((it) => it.block.type === 'data_visualization').map((it) => it.block);
  await sql`
    insert into reply_charts (channel_id, message_ts, charts, extras)
    values (${channelId}, ${messageTs}, ${sql.json(charts as any)}, ${serializeExtras(extras)})
    on conflict (channel_id, message_ts) do update set charts = excluded.charts, extras = excluded.extras`;
}

export async function extrasForMessage(channelId: string, messageTs: string | null | undefined): Promise<ReplyExtras | null> {
  if (!messageTs) return null;
  const [row] = await sql<{ charts: unknown; extras: string | null }[]>`
    select charts, extras from reply_charts where channel_id = ${channelId} and message_ts = ${messageTs}`;
  if (!row) return null;
  const parsed = parseExtras(row.extras);
  if (parsed) return parsed;
  // Rows from before reply_extras: charts only.
  const charts = storedCharts(row.charts);
  if (!charts.length) return null;
  return { items: charts.map(chartExtra) };
}
