/**
 * The live preview's buttons ("Get claim link", Report) and context line: under the code-posted preview message and
 * under a front agent reply that passes `preview: "pv_…"` (src/agent/tools.ts). The buttons are handled in flow.ts
 * (`preview:claim`, `preview:report`); the claim URL itself never leaves those handlers.
 */
import type { ReplyExtra } from '../../agent/rich-blocks.js';
import { getPreview, type PreviewRow } from './store.js';

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
