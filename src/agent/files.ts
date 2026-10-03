// OWNER: agent module. Stub signature — shared upload helper (reply + send_message).
export interface OutgoingFile {
  filename: string;
  content: string; // text content produced by the model
}

/** Upload files via files.getUploadURLExternal + files.completeUploadExternal into a channel/thread. */
export async function uploadFiles(opts: { channelId: string; threadTs?: string; files: OutgoingFile[]; idempotencyKey: string }): Promise<void> {
  throw new Error('not implemented');
}
