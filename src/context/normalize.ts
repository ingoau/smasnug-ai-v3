/** Pure normalisation of Slack API messages and stored rows into RenderMsg. */
import type { MessageAttachment, SlackFileRef, StoredMessage } from '../core/types.js';
import type { RenderMsg } from './format.js';
import { reactionsFromSlack } from './reactions.js';
import { isHiddenMessage } from '../pipeline/guidelines.js';

export const HIDDEN_SUBTYPES = new Set(['tombstone', 'message_deleted', 'channel_join', 'channel_leave', 'group_join', 'group_leave']);

/** Stored per attachment at most (the renderer cuts further). */
const ATTACHMENT_TEXT_MAX = 4000;
const ATTACHMENT_FIELD_MAX = 200;
const MAX_ATTACHMENTS = 5;

const field = (v: unknown, max = ATTACHMENT_FIELD_MAX) => {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, max) : undefined;
};

/** A forward without `from_url`: a permalink built from the share's channel and ts (read tools take any host). */
function sharePermalink(a: any): string | undefined {
  const ch = typeof a.channel_id === 'string' && /^[CG][A-Z0-9]+$/.test(a.channel_id) ? a.channel_id : undefined;
  const ts = typeof a.ts === 'string' && /^\d{10}\.\d{6}$/.test(a.ts) ? a.ts : undefined;
  return ch && ts ? `https://slack.com/archives/${ch}/p${ts.replace('.', '')}` : undefined;
}

/**
 * Slack `attachments` → MessageAttachment[] (pure): forwarded messages and Slack message unfurls ('forwarded'),
 * link unfurls ('link', with the page's title and description), other app attachments ('attached'). Ones without
 * any text are dropped, and so is forwarded / unfurled content that starts with `##` (workspace guidelines).
 */
export function attachmentsFromSlack(raw: unknown): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageAttachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const body = String(a.text || a.fallback || '').trim();
    if (isHiddenMessage(body) || isHiddenMessage(a.pretext)) continue;
    const message = Boolean(a.is_share || a.is_msg_unfurl);
    const link = !message && Boolean(a.from_url || a.original_url || a.title_link || a.service_name);
    const title = field(a.title);
    const text = body ? body.slice(0, ATTACHMENT_TEXT_MAX) : undefined;
    if (!text && !title) continue;
    const url = field(a.from_url || a.original_url || a.title_link, 500) || (message ? sharePermalink(a) : undefined);
    out.push({
      kind: message ? 'forwarded' : link ? 'link' : 'attached',
      ...(field(a.author_name || a.author_subname) ? { author: field(a.author_name || a.author_subname) } : {}),
      ...(typeof a.author_id === 'string' && /^[UW][A-Z0-9]+$/.test(a.author_id) ? { authorId: a.author_id } : {}),
      ...(field(a.channel_name) ? { channel: field(a.channel_name) } : {}),
      ...(title ? { title } : {}),
      ...(text ? { text } : {}),
      ...(url && /^https?:\/\//.test(url) ? { url } : {}),
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/** At most this many files from forwarded messages per message. */
const MAX_FORWARDED_FILES = 10;

/**
 * A Slack message's files (pure): its own, then those of forwarded messages it carries (`attachments[].files` of
 * `is_share` attachments, marked `forwarded`, so a forwarded screenshot gets a file id like an upload). Tombstones (removed files), files hidden by the plan's
 * limit and files on forwarded `##` content are dropped.
 */
export function slackFileRefs(raw: any): SlackFileRef[] {
  const out: SlackFileRef[] = [];
  const seen = new Set<string>();
  const add = (f: any, forwarded = false) => {
    if (!f?.id || typeof f.id !== 'string' || seen.has(f.id) || f.mode === 'tombstone' || f.mode === 'hidden_by_limit') return;
    seen.add(f.id);
    out.push({
      id: f.id,
      name: f.name || f.title || undefined,
      mimetype: f.mimetype || undefined,
      urlPrivate: f.url_private || undefined,
      ...(typeof f.size === 'number' ? { size: f.size } : {}),
      ...(forwarded || f.forwarded === true ? { forwarded: true } : {}),
    });
  };
  for (const f of Array.isArray(raw?.files) ? raw.files : []) add(f);
  let forwarded = 0;
  for (const a of Array.isArray(raw?.attachments) ? raw.attachments : []) {
    // Forwards only: a link unfurl (is_msg_unfurl) of a message elsewhere, e.g. in a private channel, shows its
    // files to whoever sees the unfurl, but they aren't shared here, so they never get ids.
    if (!a || typeof a !== 'object' || !a.is_share || !Array.isArray(a.files)) continue;
    if (isHiddenMessage(String(a.text || a.fallback || '')) || isHiddenMessage(a.pretext)) continue;
    for (const f of a.files) {
      if (forwarded >= MAX_FORWARDED_FILES) break;
      const before = out.length;
      add(f, true);
      if (out.length > before) forwarded++;
    }
  }
  return out;
}

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
  const files = slackFileRefs(raw);
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
    attachments: attachmentsFromSlack(raw.attachments),
  };
}

export function fromStored(m: StoredMessage | (StoredMessage & Record<string, any>)): RenderMsg {
  const files = ((m.files as any[]) ?? []).map((f: any) => ({
    id: f.id,
    name: f.name ?? f.title,
    mimetype: f.mimetype,
    urlPrivate: f.urlPrivate ?? f.url_private ?? f.urlPrivateDownload,
    ...(typeof f.size === 'number' ? { size: f.size } : {}),
    ...(f.forwarded ? { forwarded: true } : {}),
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
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
  };
}

