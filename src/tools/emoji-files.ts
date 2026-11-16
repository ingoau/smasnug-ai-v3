/**
 * upload_emoji (front only, registered only when the userbot session is configured): a stored image file added as a
 * custom emoji with `emoji.add`, the web client's own method (no app token can add emoji), called as the userbot
 * (`slackCall(..., { token: 'userbot' })`): multipart `name`, `mode=data`, `image`.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../config.js';
import { appendEvent } from '../core/events.js';
import { slackCall, slackErrorCode, SlackUpload, userbotConfigured } from '../core/slack.js';
import { registerTool, type ToolContext } from '../core/tools.js';
import { registerButtonAction } from '../agent/button-actions.js';
import { peekLimit, takeLimit } from '../features/guard.js';
import { FileError, loadFileBytes, resolveFile } from '../files/store.js';
import { formatBytes, sniffMime } from '../files/format.js';
import { log } from '../log.js';
import { cleanEmojiName } from './emoji.js';
import { forgetEmojiList } from './emoji-download.js';

/** Image types emoji.add takes (its error_bad_format: "GIF, JPEG, PNG, or WEBP"). */
export const EMOJI_MIMES: Record<string, string> = { 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Slack custom-emoji shortcodes: lowercase letters, numbers, underscores, hyphens. */
const NAME_RE = /^[a-z0-9_-]{1,100}$/;

const ADD_ERRORS: Record<string, string> = {
  error_name_taken: 'That emoji name is already taken.',
  error_bad_format: 'Slack only accepts GIF, JPEG, PNG, or WEBP for a custom emoji.',
  not_authed: 'The userbot session was rejected (token or cookie).',
  invalid_auth: 'The userbot session was rejected (token or cookie).',
  not_configured: 'Emoji upload is not configured.',
};

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Why these bytes can't be an emoji image, or null when they can. `mime` is the type to send. */
export function emojiImageProblem(bytes: Buffer, declaredMime: string | null | undefined): { error: string } | { mime: string; ext: string } {
  const mime = sniffMime(bytes) ?? declaredMime ?? '';
  const ext = EMOJI_MIMES[mime];
  if (!ext) return { error: `This file is ${mime || 'not an image Slack accepts'}. Custom emoji have to be GIF, JPEG, PNG, or WEBP.` };
  if (bytes.byteLength > limits.emojiUploadMaxBytes) {
    return { error: `This image is ${formatBytes(bytes.byteLength)}; the limit for an emoji upload is ${formatBytes(limits.emojiUploadMaxBytes)}.` };
  }
  return { mime, ext };
}

type UploadCtx = Pick<ToolContext, 'threadId' | 'speakerId'> & { turnId?: number | null; abortSignal?: AbortSignal };
type Prepared = { error: string } | { name: string; fileId: string; filename: string; bytes: Buffer; mime: string };

/** Everything that can be checked before uploading: name, file access, image, the speaker's hourly limit. */
async function prepareUpload(ctx: Pick<ToolContext, 'threadId' | 'speakerId'>, nameRaw: string, fileId: string): Promise<Prepared> {
  if (!userbotConfigured()) return { error: 'Emoji upload is not configured (no userbot session).' };
  const name = cleanEmojiName(nameRaw);
  if (!NAME_RE.test(name)) return { error: `Emoji name "${name || nameRaw.trim()}" isn't usable. Use letters, numbers, underscores or hyphens.` };
  const f = await resolveFile(fileId, { threadId: ctx.threadId, speakerId: ctx.speakerId });
  if ('error' in f) return { error: f.error };
  let bytes: Buffer;
  try {
    bytes = await loadFileBytes(f);
  } catch (err) {
    return { error: `${f.name} (${f.id}) couldn't be opened: ${err instanceof FileError ? err.message : errMsg(err)}.` };
  }
  const image = emojiImageProblem(bytes, f.mime);
  if ('error' in image) return { error: image.error };
  const blocked = await peekLimit('emoji_upload', ctx.speakerId);
  if (blocked) return { error: blocked };
  return { name, fileId: f.id, filename: f.name.includes('.') ? f.name : `${name}.${image.ext}`, bytes, mime: image.mime };
}

/**
 * Add `fileId` as a custom emoji named `nameRaw`. The image has to be one the speaker can already use. The hourly
 * upload limit is checked before sending and counted only when Slack added the emoji. `key` scopes the idempotency
 * key (a turn, a run, a button press); without one, nothing dedupes a retry.
 */
export async function addEmoji(ctx: UploadCtx, nameRaw: string, fileId: string, key: string | null): Promise<{ ok: boolean; text: string }> {
  const p = await prepareUpload(ctx, nameRaw, fileId);
  if ('error' in p) return { ok: false, text: p.error };
  const { name } = p;
  try {
    await slackCall(
      'emoji.add',
      { name, mode: 'data', image: new SlackUpload(p.bytes, p.filename, p.mime) },
      { token: 'userbot', signal: ctx.abortSignal, ...(key ? { idempotencyKey: `emoji-add:${ctx.threadId}:${key}:${name}:${p.fileId}` } : {}) },
    );
  } catch (err) {
    if ((err as { code?: string })?.code === 'slack_webapi_request_error') {
      log.warn({ err, name }, 'emoji.add got no answer');
      return { ok: false, text: `Slack didn't answer in time, so :${name}: may or may not have been added. Check before trying again.` };
    }
    const code = slackErrorCode(err);
    log.debug({ err, code, name }, 'emoji.add failed');
    return { ok: false, text: ADD_ERRORS[code ?? ''] ?? `Couldn't add :${name}: (${code || errMsg(err)}).` };
  }
  // Counted once it's added (a taken name or a broken session doesn't use up the user's uploads).
  await takeLimit('emoji_upload', ctx.speakerId, ctx.threadId).catch((err) => log.warn({ err }, 'emoji_upload usage not recorded'));
  await forgetEmojiList();
  // Emoji are added in the userbot's name: who asked is kept in the logs and the thread's events.
  log.info({ name, requestedBy: ctx.speakerId, threadId: ctx.threadId, fileId: p.fileId }, 'custom emoji added');
  await appendEvent(ctx.threadId, 'emoji_added', 'bot', { name, fileId: p.fileId, requestedBy: ctx.speakerId, turnId: ctx.turnId ?? null }).catch((err) => log.debug({ err }, 'emoji_added event failed'));
  return { ok: true, text: `Added :${name}: from ${p.fileId}.` };
}

/** The upload_emoji tool: addEmoji scoped to the turn / run. */
export async function uploadEmoji(ctx: Pick<ToolContext, 'threadId' | 'speakerId' | 'turnId' | 'runId' | 'abortSignal'>, nameRaw: string, fileId: string): Promise<string> {
  const scope = ctx.turnId != null ? `turn:${ctx.turnId}` : ctx.runId != null ? `run:${ctx.runId}` : null;
  return (await addEmoji(ctx, nameRaw, fileId, scope)).text;
}

const uploadArgs = z.object({
  name: z.string().describe('Emoji shortcode without colons, e.g. cat_wave'),
  file_id: z.string().describe('file_… id of the image'),
});

if (userbotConfigured()) {
  registerTool({
    name: 'upload_emoji',
    roles: ['front'],
    build: (ctx) =>
      tool({
        description:
          'Add a custom emoji to this workspace from an image file already in the conversation (GIF, JPEG, PNG, or WEBP). Only when the speaker clearly asks to add one. Then tell them the name. ' +
          'When you show an emoji for review first (e.g. one you made), don\'t ask them to say the word: put an action button on that reply that uploads it on press, e.g. ' +
          '{ "label": "Upload it", "type": "action", "action": { "tool": "upload_emoji", "args": { "name": "cat_wave", "file_id": "file_…" } }, "done_text": "uploaded, :cat_wave: is live" }. ' +
          'Call this tool directly when they already asked to upload it as is.',
        inputSchema: uploadArgs,
        execute: async ({ name, file_id }) => uploadEmoji(ctx, name, file_id),
      }),
  });
}

if (userbotConfigured()) {
  // The same upload, bound to a reply's action button (src/agent/button-actions.ts): runs as whoever pressed it.
  registerButtonAction({
    name: 'upload_emoji',
    args: uploadArgs,
    check: async (ctx, a) => {
      const p = await prepareUpload(ctx, a.name, a.file_id);
      return 'error' in p ? p.error : null;
    },
    run: (ctx, a) => addEmoji(ctx, a.name, a.file_id, `button:${ctx.key}`),
  });
}
