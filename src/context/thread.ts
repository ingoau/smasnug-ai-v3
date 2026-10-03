// OWNER: tools/context module. Stub signature — implemented by the tools agent.

export interface RenderedThreadContext {
  /** Parent + last N replies (with `[k earlier replies not shown]`), author-labelled, truncated, file/image placeholders. */
  history: string;
  /** ~5 channel messages around the thread parent. Empty for DMs. */
  channelContext: string;
  /** The turn's new messages rendered the same way. */
  newMessages: string;
}

/**
 * Render a thread for a front-agent turn. Backfills from conversations.replies on first use of a thread
 * (threads.backfilled), and assigns stable `img_N` ids to images (thread_images).
 */
export async function renderThreadContext(threadId: string, opts: { newMessageTs: string[] }): Promise<RenderedThreadContext> {
  throw new Error('not implemented');
}

/** Render specific messages (e.g. inbox messages injected mid-turn) in the same format. */
export async function renderMessages(threadId: string, ts: string[]): Promise<string> {
  throw new Error('not implemented');
}
