/**
 * The file store's access rule, in one place (pure; unit-tested in access.test.ts). Storage is global, access is
 * thread-scoped: a turn or subagent run may use a file when
 *  - it was created or uploaded in that thread, or
 *  - the bot posted it into that thread (it is visible there, e.g. the owner had it posted here), or
 *  - the current speaker is its owner (they uploaded it, or the bot made it at their request).
 * So "post the page you made me yesterday in #general" works for its owner, but a file from someone else's DM can't
 * be pulled into a public channel by guessing its id. Subagents act with their owner as speaker, in their thread.
 * Internal files (e.g. sandbox preview bundles) are never available through the tools.
 */

export interface FileAccessInfo {
  threadId: string;
  ownerId: string | null;
  internal?: boolean;
  /** Threads the bot posted this file into (file_posts). */
  postedThreadIds?: readonly string[];
}

export interface FileAccessContext {
  threadId: string;
  /** The turn's speaker, or the subagent's owner. */
  speakerId: string;
}

export function canUseFile(f: FileAccessInfo, ctx: FileAccessContext): boolean {
  if (f.internal) return false;
  if (f.threadId === ctx.threadId) return true;
  if (f.postedThreadIds?.includes(ctx.threadId)) return true;
  return Boolean(f.ownerId && ctx.speakerId && f.ownerId === ctx.speakerId);
}
