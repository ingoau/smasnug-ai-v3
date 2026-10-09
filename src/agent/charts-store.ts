/** Charts posted on a reply (table reply_charts). Card and button re-renders rebuild the message from DB state. */
import { sql } from '../db/index.js';
import { storedCharts, type DataVisualizationBlock } from './charts.js';

export async function saveReplyCharts(channelId: string, messageTs: string, charts: readonly DataVisualizationBlock[]): Promise<void> {
  if (!charts.length) return;
  const body = charts.map(({ type, title, chart }) => ({ type, title, chart }));
  await sql`
    insert into reply_charts (channel_id, message_ts, charts)
    values (${channelId}, ${messageTs}, ${sql.json(body as any)})
    on conflict (channel_id, message_ts) do update set charts = excluded.charts`;
}

export async function chartsForMessage(channelId: string, messageTs: string | null | undefined): Promise<DataVisualizationBlock[]> {
  if (!messageTs) return [];
  const [row] = await sql<{ charts: unknown }[]>`select charts from reply_charts where channel_id = ${channelId} and message_ts = ${messageTs}`;
  return storedCharts(row?.charts);
}
