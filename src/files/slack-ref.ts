/**
 * Slack file ids as file refs: users paste a Slack `F…` id or a file permalink (`https://<ws>.slack.com/files/U…/F…/…`)
 * where the tools take a `file_…` id. `resolveFile` sends those here:
 *
 * 1. A stored file for that Slack file the context may use (the access rule, access.ts): an upload registered in this
 *    thread, the bot's own post of a stored file, a copy seen elsewhere whose owner is the speaker.
 * 2. Otherwise it is registered as an upload of this thread, like a file on a message shown to the model, when Slack
 *    shows it is shared (files.info `shares`) in the current conversation or in a verified public channel (the
 *    read_canvas / slack_search rule), and the message it was shared with is fetched and checked: it exists, carries
 *    the file, and isn't a `##` message (guidelines). Anything unverifiable is refused (fail closed), with the same
 *    answer for "doesn't exist" and "not visible".
 */
import { env } from '../config.js';
import { parseThreadId } from '../core/events.js';
import { slackCall, slackErrorCode, type TokenKind } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { isHiddenMessage } from '../pipeline/guidelines.js';
import { slackFileRefs } from '../context/normalize.js';
import { parseCanvasId } from '../tools/canvas.js';
import { publicChannelIds } from '../tools/slack-search.js';
import type { FileAccessContext } from './access.js';
import { mimeFromName, sanitizeFileName } from './format.js';
import { newFileId } from './ids.js';
import { resolveFile, type ResolvedFile } from './store.js';

/** One entry of files.info `shares.public[channel]` / `shares.private[channel]`. */
export interface SlackShare {
  ts?: string;
  thread_ts?: string;
}

/** The fields of a files.info `file` object used here (docs.slack.dev/reference/objects/file-object). */
export interface SlackFileInfo {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  mode?: string;
  is_external?: boolean;
  size?: number;
  url_private?: string;
  permalink?: string;
  shares?: { public?: Record<string, SlackShare[]>; private?: Record<string, SlackShare[]> };
}

/** The Slack file id in a model-given ref (bare `F…`, a file permalink or canvas link, `<url|label>`), else undefined. */
export function parseSlackFileRef(input: string | undefined | null): string | undefined {
  return parseCanvasId(input);
}

export const slackFileRefused = (id: string) =>
  `Can't open Slack file ${id}: I can only open Slack files shared in this conversation or in a public channel. Ask the speaker to share it here (or post it again), or use a file id (file_…) from the conversation.`;

/** Canvases are files in Slack, but read_canvas reads them. */
export function isCanvasFile(f: Pick<SlackFileInfo, 'filetype' | 'mode' | 'pretty_type'>): boolean {
  return f.filetype === 'quip' || f.filetype === 'canvas' || f.mode === 'quip' || f.mode === 'canvas' || /^canvas$/i.test(f.pretty_type ?? '');
}

export interface PickedShare {
  channelId: string;
  ts: string;
  threadTs?: string;
  /** Verified public (not the current conversation). */
  public: boolean;
}

const TS = /^\d{9,11}\.\d{1,6}$/;

/**
 * Where a Slack file may be taken from (pure): a share in the current conversation first, else one in a verified
 * public channel (`publicIds`; never a DM). Only shares with a message ts count: the message is checked next.
 */
export function pickSlackFileShare(file: SlackFileInfo, channelId: string, publicIds: ReadonlySet<string>): PickedShare | null {
  const all: [string, SlackShare[]][] = [...Object.entries(file.shares?.public ?? {}), ...Object.entries(file.shares?.private ?? {})];
  const first = (ch: string, list: SlackShare[], isPublic: boolean): PickedShare | null => {
    for (const s of Array.isArray(list) ? list : []) {
      if (typeof s?.ts !== 'string' || !TS.test(s.ts)) continue;
      const threadTs = typeof s.thread_ts === 'string' && TS.test(s.thread_ts) && s.thread_ts !== s.ts ? s.thread_ts : undefined;
      return { channelId: ch, ts: s.ts, ...(threadTs ? { threadTs } : {}), public: isPublic };
    }
    return null;
  };
  for (const [ch, list] of all) {
    const hit = ch === channelId ? first(ch, list, false) : null;
    if (hit) return hit;
  }
  for (const [ch, list] of all) {
    if (ch.startsWith('D') || !publicIds.has(ch)) continue;
    const hit = first(ch, list, true);
    if (hit) return hit;
  }
  return null;
}

/** Channels worth a public check (pure): shared-in conversations other than the current one and DMs. */
export function shareCandidates(file: SlackFileInfo, channelId: string): string[] {
  const ids = new Set([...Object.keys(file.shares?.public ?? {}), ...Object.keys(file.shares?.private ?? {})]);
  return [...ids].filter((id) => id !== channelId && /^[CG][A-Z0-9]+$/.test(id));
}

/** The raw message the file was shared with may be shown (pure): it isn't a `##` message and carries the file. */
export function messageCarriesFile(raw: any, fileId: string): boolean {
  if (!raw || isHiddenMessage(raw.text)) return false;
  return slackFileRefs(raw).some((f) => f.id === fileId);
}

async function filesInfo(id: string, token: TokenKind): Promise<SlackFileInfo | undefined> {
  try {
    const res = await slackCall<any>('files.info', { file: id, count: 1 }, { token, maxWaitMs: 5_000 });
    return res?.file && res.file.id === id ? (res.file as SlackFileInfo) : undefined;
  } catch (err) {
    const code = slackErrorCode(err);
    if (code !== 'file_not_found' && code !== 'file_deleted' && code !== 'not_visible') log.warn({ err, id, token }, 'files.info for a Slack file id failed');
    return undefined;
  }
}

/** The message at `share` (conversations.history / .replies), or undefined when it can't be fetched. */
async function shareMessage(share: PickedShare, token: TokenKind): Promise<any | undefined> {
  try {
    const res = share.threadTs
      ? await slackCall<any>('conversations.replies', { channel: share.channelId, ts: share.threadTs, oldest: share.ts, latest: share.ts, inclusive: true, limit: 2 }, { token, maxWaitMs: 5_000 })
      : await slackCall<any>('conversations.history', { channel: share.channelId, oldest: share.ts, latest: share.ts, inclusive: true, limit: 1 }, { token, maxWaitMs: 5_000 });
    return ((res?.messages ?? []) as any[]).find((m) => m?.ts === share.ts);
  } catch (err) {
    log.info({ err, channel: share.channelId, ts: share.ts }, 'fetching the message of a Slack file share failed');
    return undefined;
  }
}

/** A stored file for this Slack file that the context may use (resolveFile applies the access rule). */
async function storedFile(slackFileId: string, ctx: FileAccessContext): Promise<ResolvedFile | null> {
  const rows = await sql<{ id: string }[]>`
    select id from (
      select id, (thread_id = ${ctx.threadId}) as here, created_at from files where slack_file_id = ${slackFileId} and not internal
      union all
      select f.id, (p.thread_id = ${ctx.threadId}) as here, f.created_at from file_posts p join files f on f.id = p.file_id
      where p.slack_file_id = ${slackFileId} and not f.internal
    ) c order by here desc, created_at desc limit 10`;
  for (const { id } of rows) {
    const f = await resolveFile(id, ctx);
    if (!('error' in f)) return f;
  }
  return null;
}

/** Resolve a Slack file id under the rules above. */
export async function resolveSlackFile(slackFileId: string, ctx: FileAccessContext): Promise<ResolvedFile | { error: string }> {
  const stored = await storedFile(slackFileId, ctx);
  if (stored) return stored;

  const { channelId } = parseThreadId(ctx.threadId);
  // The bot token sees files in conversations it is in; the user token (when configured) is only good for public ones.
  let token: TokenKind = 'bot';
  let file = await filesInfo(slackFileId, 'bot');
  if (!file && env.SLACK_USER_TOKEN) {
    file = await filesInfo(slackFileId, 'user');
    token = 'user';
  }
  if (!file) return { error: slackFileRefused(slackFileId) };
  if (isCanvasFile(file)) return { error: `${slackFileId} is a Slack canvas, not a file: read it with read_canvas.` };
  if (file.mode === 'tombstone' || file.mode === 'hidden_by_limit') return { error: slackFileRefused(slackFileId) };
  if (file.is_external || file.mode === 'external' || !file.url_private) {
    return { error: `${slackFileId} is a link to an external file (not stored in Slack), so it can't be opened as a file.` };
  }

  // Seen only through the user token: the current conversation's shares don't count (the bot couldn't see it there).
  const here = token === 'user' ? '' : channelId;
  const candidates = shareCandidates(file, here);
  const publicIds = candidates.length ? await publicChannelIds(candidates, { maxWaitMs: 5_000 }).catch(() => new Set<string>()) : new Set<string>();
  const share = pickSlackFileShare(file, here, publicIds);
  if (!share) return { error: slackFileRefused(slackFileId) };
  const readToken: TokenKind = share.public && env.SLACK_USER_TOKEN ? 'user' : 'bot';
  const raw = await shareMessage(share, readToken);
  if (!messageCarriesFile(raw, slackFileId)) return { error: slackFileRefused(slackFileId) };

  const name = sanitizeFileName(file.name || file.title || slackFileId);
  const row = {
    id: newFileId(),
    origin: 'upload',
    thread_id: ctx.threadId,
    channel_id: channelId,
    // Not the speaker's upload: no owner, so it stays usable in this thread only.
    owner_id: null,
    slack_file_id: slackFileId,
    slack_url: file.url_private,
    message_ts: share.ts,
    source_channel_id: share.channelId !== channelId ? share.channelId : null,
    source_public: share.public,
    name,
    mime: file.mimetype || mimeFromName(name) || null,
    size: typeof file.size === 'number' ? file.size : null,
  };
  await sql`
    insert into files ${sql(row, 'id', 'origin', 'thread_id', 'channel_id', 'owner_id', 'slack_file_id', 'slack_url', 'message_ts', 'source_channel_id', 'source_public', 'name', 'mime', 'size')}
    on conflict do nothing`;
  // Ours, or the row another worker registered for this thread meanwhile.
  const [hit] = await sql<{ id: string }[]>`select id from files where thread_id = ${ctx.threadId} and slack_file_id = ${slackFileId} limit 1`;
  if (!hit) return { error: slackFileRefused(slackFileId) };
  return resolveFile(hit.id, ctx);
}
