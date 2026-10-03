// OWNER: agent module. Shared upload helper (reply + send_message).
import { slackCall } from '../core/slack.js';

export interface OutgoingFile {
  filename: string;
  content: string; // text content produced by the model
}

const FAKE = () => process.env.SLACK_FAKE === '1';

/**
 * Upload files via files.getUploadURLExternal → POST to upload_url → files.completeUploadExternal into a
 * channel/thread. The complete call carries the idempotency key, so a retried turn never shares files twice.
 */
export async function uploadFiles(opts: { channelId: string; threadTs?: string; files: OutgoingFile[]; idempotencyKey: string }): Promise<void> {
  if (opts.files.length === 0) return;
  const uploaded: { id: string; title: string }[] = [];
  for (const f of opts.files) {
    const bytes = Buffer.from(f.content, 'utf8');
    const res = await slackCall<any>('files.getUploadURLExternal', { filename: f.filename, length: bytes.byteLength });
    if (!res.upload_url || !res.file_id) throw new Error('files.getUploadURLExternal returned no upload_url');
    if (!FAKE()) {
      const up = await fetch(res.upload_url, {
        method: 'POST',
        body: bytes,
        headers: { 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!up.ok) throw new Error(`file upload failed: HTTP ${up.status}`);
    }
    uploaded.push({ id: res.file_id, title: f.filename });
  }
  await slackCall(
    'files.completeUploadExternal',
    { files: uploaded, channel_id: opts.channelId, ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}) },
    { idempotencyKey: opts.idempotencyKey },
  );
}
