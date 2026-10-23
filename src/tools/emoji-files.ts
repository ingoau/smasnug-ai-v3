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
import { takeLimit } from '../features/guard.js';
import { FileError, loadFileBytes, resolveFile } from '../files/store.js';
import { formatBytes, sniffMime } from '../files/format.js';
import { log } from '../log.js';
import { cleanEmojiName } from './emoji.js';

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

/**
 * Add `fileId` as a custom emoji named `nameRaw`. The image has to be one the speaker can already use.
 * Counts against the hourly upload limit only once the image is actually sent.
 */
export async function uploadEmoji(ctx: Pick<ToolContext, 'threadId' | 'speakerId' | 'turnId' | 'runId'>, nameRaw: string, fileId: string): Promise<string> {
  if (!userbotConfigured()) return 'Emoji upload is not configured (no userbot session).';
  const name = cleanEmojiName(nameRaw);
  if (!NAME_RE.test(name)) return `Emoji name "${name || nameRaw.trim()}" isn't usable. Use letters, numbers, underscores or hyphens.`;
  const f = await resolveFile(fileId, { threadId: ctx.threadId, speakerId: ctx.speakerId });
  if ('error' in f) return f.error;
  let bytes: Buffer;
  try {
    bytes = await loadFileBytes(f);
  } catch (err) {
    return `${f.name} (${f.id}) couldn't be opened: ${err instanceof FileError ? err.message : errMsg(err)}.`;
  }
  const image = emojiImageProblem(bytes, f.mime);
  if ('error' in image) return image.error;
  const blocked = await takeLimit('emoji_upload', ctx.speakerId, ctx.threadId);
  if (blocked) return blocked;
  const filename = f.name.includes('.') ? f.name : `${name}.${image.ext}`;
  try {
    await slackCall(
      'emoji.add',
      { name, mode: 'data', image: new SlackUpload(bytes, filename, image.mime) },
      { token: 'userbot', idempotencyKey: `emoji-add:${ctx.threadId}:${ctx.turnId ?? ctx.runId ?? 'na'}:${name}:${f.id}` },
    );
  } catch (err) {
    const code = slackErrorCode(err);
    log.debug({ err, code, name }, 'emoji.add failed');
    return ADD_ERRORS[code ?? ''] ?? `Couldn't add :${name}: (${code || errMsg(err)}).`;
  }
  await appendEvent(ctx.threadId, 'emoji_added', 'bot', { name, fileId: f.id, turnId: ctx.turnId ?? null }).catch((err) => log.debug({ err }, 'emoji_added event failed'));
  return `Added :${name}: from ${f.id}.`;
}

if (userbotConfigured()) {
  registerTool({
    name: 'upload_emoji',
    roles: ['front'],
    build: (ctx) =>
      tool({
        description:
          'Add a custom emoji to this workspace from an image file already in the conversation (GIF, JPEG, PNG, or WEBP). Only when the speaker clearly asks to add one. Then tell them the name.',
        inputSchema: z.object({
          name: z.string().describe('Emoji shortcode without colons, e.g. cat_wave'),
          file_id: z.string().describe('file_… id of the image'),
        }),
        execute: async ({ name, file_id }) => uploadEmoji(ctx, name, file_id),
      }),
  });
}
