/**
 * The live preview's buttons ("Get claim link", Report) and context line: under the code-posted preview message and
 * under a front agent reply that passes `preview: "pv_…"` (src/agent/tools.ts). The buttons are handled in flow.ts
 * (`preview:claim`, `preview:report`); the claim URL itself never leaves those handlers. Also the code-posted
 * preview message (a fallback) and the results-turn safety net that posts it for live previews nobody announced.
 */
import type { ReplyExtra } from '../../agent/rich-blocks.js';
import { parseThreadId, threadTsArg } from '../../core/events.js';
import { slackCall } from '../../core/slack.js';
import { sql } from '../../db/index.js';
import { getPreview, setMessageTs, type PreviewRow } from './store.js';

/** The claim + report buttons and the context line of a live preview (also under a front reply with `preview`). */
export function previewButtonBlocks(row: Pick<PreviewRow, 'id' | 'requesterId'>): unknown[] {
  return [
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'preview:claim', text: { type: 'plain_text', text: 'Get claim link' }, value: row.id },
        { type: 'button', action_id: 'preview:report', text: { type: 'plain_text', text: 'Report' }, value: row.id },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Temporary Cloudflare deployment. Only <@${row.requesterId}> can claim it to keep it.` }] },
  ];
}

/**
 * Reply extras for `reply(preview)`: the buttons when the preview is live and belongs to this thread, else a note for
 * the model (and nothing is added).
 */
export async function previewReplyExtras(threadId: string, previewId: string): Promise<{ items: ReplyExtra[]; note: string | null }> {
  const id = previewId.trim();
  const row = /^pv_[A-Za-z0-9]+$/.test(id) ? await getPreview(id) : null;
  if (!row || row.threadId !== threadId) return { items: [], note: `No preview ${id.slice(0, 40)} in this thread, so no claim button was added.` };
  if (row.status !== 'live') return { items: [], note: `Preview ${row.id} is ${row.status.replace('_', ' ')}, not live, so no claim button was added.` };
  const [actions, context] = previewButtonBlocks(row) as Record<string, unknown>[];
  const fallback = row.url ? `Live preview: ${row.url}` : '';
  return {
    items: [
      { ref: 'preview:1', block: actions!, fallback, summary: '' },
      { ref: 'preview:2', block: context!, fallback: '', summary: '' },
    ],
    note: null,
  };
}

export function previewMessage(row: PreviewRow): { text: string; blocks: unknown[] } {
  const exp = row.expiresAt ?? new Date();
  const epoch = Math.floor(exp.getTime() / 1000);
  const hhmm = exp.toISOString().slice(11, 16);
  const title = row.title.replace(/[<>&*_~`]/g, '');
  const text = `Live preview of ${title} for <@${row.requesterId}>: ${row.url} · expires ${hhmm} UTC`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Live preview of *${title}* for <@${row.requesterId}>: <${row.url}> · expires <!date^${epoch}^{time}|${hhmm} UTC>` } },
      ...previewButtonBlocks(row),
    ],
  };
}

/** Post the code preview message in its thread (once per preview) and record it (message_ts, announced_at). */
export async function postPreviewMessage(row: PreviewRow): Promise<string | null> {
  const { channelId, threadTs } = parseThreadId(row.threadId);
  const m = previewMessage(row);
  const res = await slackCall<any>('chat.postMessage', { channel: channelId, ...threadTsArg(threadTs), text: m.text, blocks: m.blocks, unfurl_links: false, unfurl_media: false }, { idempotencyKey: `preview:${row.id}` });
  const ts = typeof res?.ts === 'string' ? res.ts : null;
  if (ts) await setMessageTs(row.id, ts);
  return ts;
}

/**
 * Results-turn safety net: live previews of these runs that no message announced yet (a silent turn, or a reply
 * without `preview`) get the code message. Returns the ts of the messages posted.
 */
export async function postUnannouncedPreviews(runIds: number[]): Promise<string[]> {
  if (!runIds.length) return [];
  const rows = await sql<PreviewRow[]>`
    select * from previews where run_id in ${sql(runIds)} and status = 'live' and announced_at is null and url is not null order by created_at`;
  const posted: string[] = [];
  for (const r of rows) {
    const ts = await postPreviewMessage(r);
    if (ts) posted.push(ts);
  }
  return posted;
}
