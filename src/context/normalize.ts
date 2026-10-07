/** Pure normalisation of Slack API messages and stored rows into RenderMsg. */
import type { SlackFileRef, StoredMessage } from '../core/types.js';
import type { RenderMsg } from './format.js';
import { reactionsFromSlack } from './reactions.js';
import { isHiddenMessage } from '../pipeline/guidelines.js';

export const HIDDEN_SUBTYPES = new Set(['tombstone', 'message_deleted', 'channel_join', 'channel_leave', 'group_join', 'group_leave']);

/**
 * Slack API message → RenderMsg. Returns null for messages that should never be shown (joins, tombstones, and `##`
 * messages, which the workspace guidelines hide from bots entirely).
 */
export function fromSlack(raw: any): RenderMsg | null {
  if (!raw?.ts) return null;
  if (raw.subtype && HIDDEN_SUBTYPES.has(raw.subtype)) return null;
  if (isHiddenMessage(raw.text)) return null;
  let text: string = raw.text ?? '';
  if (!text && Array.isArray(raw.attachments)) {
    text = raw.attachments
      .map((a: any) => a.fallback || a.text || a.title || '')
      .filter(Boolean)
      .join('\n');
  }
  const files: SlackFileRef[] = (raw.files ?? [])
    .filter((f: any) => f?.id && f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit')
    .map((f: any) => ({
      id: f.id,
      name: f.name || f.title || undefined,
      mimetype: f.mimetype || undefined,
      urlPrivate: f.url_private || undefined,
      ...(typeof f.size === 'number' ? { size: f.size } : {}),
    }));
  return {
    ts: raw.ts,
    userId: raw.user ?? null,
    botId: raw.bot_id ?? null,
    username: raw.username || raw.bot_profile?.name || null,
    text,
    files,
    edited: !!raw.edited,
    deleted: false,
    replyCount: raw.reply_count || undefined,
    reactions: reactionsFromSlack(raw.reactions),
  };
}

export function fromStored(m: StoredMessage | (StoredMessage & Record<string, any>)): RenderMsg {
  const files = ((m.files as any[]) ?? []).map((f: any) => ({
    id: f.id,
    name: f.name ?? f.title,
    mimetype: f.mimetype,
    urlPrivate: f.urlPrivate ?? f.url_private ?? f.urlPrivateDownload,
    ...(typeof f.size === 'number' ? { size: f.size } : {}),
  }));
  return {
    ts: m.ts,
    userId: m.userId,
    botId: m.botId,
    username: m.username,
    text: m.text ?? '',
    files,
    edited: !!m.editedAt,
    deleted: !!m.deleted,
    reactions: Array.isArray(m.reactions) ? m.reactions : [],
  };
}

