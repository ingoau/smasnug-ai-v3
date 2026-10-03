// OWNER: features module. Stub signatures — implemented by the features agent.

export type EntryCheck = { ok: true } | { ok: false; reason: 'paused' | 'channel_disabled' | 'suspended' | 'rate_limited' };

/** Checked at every entry point (new turns, button clicks, App Home): global pause, channel disable, suspension, messages/hour. */
export async function checkEntry(userId: string, channelId?: string): Promise<EntryCheck> {
  return { ok: true };
}

export type LimitKind = 'search' | 'fetch' | 'send' | 'subagent';

/** Per-user / per-thread limits. Returns an error string for the model if over limit, else null (and counts usage). */
export async function takeLimit(kind: LimitKind, userId: string, threadId?: string): Promise<string | null> {
  return null;
}

/** Record model token usage (per user/thread) for limits and cost. */
export async function recordModelUsage(opts: { userId?: string; threadId?: string; model: string; inputTokens?: number; outputTokens?: number }): Promise<void> {}
