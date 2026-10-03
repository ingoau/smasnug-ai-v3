/**
 * Pure decision logic for "When the bot responds" (design doc). No I/O, no config imports: everything is passed in
 * so it can be unit-tested directly.
 */

/** Why a message joins a debounce batch. Anything but 'gate' runs the front agent without the relevance gate. */
export type BatchReason = 'dm' | 'mention' | 'direct' | 'stop' | 'gate';

export type Decision =
  | { action: 'ignore'; reason: 'bot' | 'not_engaged' | 'mentions_other' | 'disengaged' | 'unsupported' }
  | { action: 'batch'; reason: BatchReason; disengage?: boolean };

export interface MessageFacts {
  isBot: boolean;
  isDm: boolean;
  mentionsBot: boolean;
  mentionsOthers: boolean;
  /** Thread state before this message (DMs are always treated as engaged). */
  engaged: boolean;
  /** Disengagement thresholds crossed (computed by shouldDisengage after counting this message). */
  disengageDue: boolean;
  /** Only the original poster and the bot have spoken in the thread, and this author is the original poster. */
  twoParty: boolean;
  isStop: boolean;
}

export function decide(f: MessageFacts): Decision {
  if (f.isBot) return { action: 'ignore', reason: 'bot' };
  if (f.isDm) return { action: 'batch', reason: 'dm' };
  if (f.mentionsBot) return f.isStop ? { action: 'batch', reason: 'stop', disengage: true } : { action: 'batch', reason: 'mention' };
  if (!f.engaged) return { action: 'ignore', reason: 'not_engaged' };
  // "Stop" is delivered to the agent (so it can cancel subagents and stay quiet) and disengages the thread.
  if (f.isStop && !f.mentionsOthers) return { action: 'batch', reason: 'stop', disengage: true };
  if (f.disengageDue) return { action: 'ignore', reason: 'disengaged' };
  if (f.mentionsOthers) return { action: 'ignore', reason: 'mentions_other' };
  if (f.twoParty) return { action: 'batch', reason: 'direct' };
  return { action: 'batch', reason: 'gate' };
}

/** A batch runs the front agent without the gate if any of its messages had a deterministic reason. */
export function batchNeedsGate(reasons: BatchReason[]): boolean {
  return reasons.length > 0 && reasons.every((r) => r === 'gate');
}

/** Mention/DM turns get the status indicator. */
export function batchIsMention(reasons: BatchReason[]): boolean {
  return reasons.some((r) => r === 'dm' || r === 'mention' || r === 'stop');
}

export interface EngagementState {
  /** Count of human messages since the bot was last addressed, including the current one. */
  messagesSinceAddressed: number;
  lastAddressedAt: Date | null;
}

export function shouldDisengage(s: EngagementState, now: Date, opts: { afterMessages: number; afterMs: number }): boolean {
  if (s.messagesSinceAddressed > opts.afterMessages) return true;
  if (s.lastAddressedAt && now.getTime() - s.lastAddressedAt.getTime() > opts.afterMs) return true;
  return false;
}

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export function mentionedUsers(text: string): string[] {
  return [...text.matchAll(USER_MENTION)].map((m) => m[1]!);
}

export function mentionFacts(text: string, botUserId: string) {
  const users = mentionedUsers(text);
  const mentionsBot = users.includes(botUserId);
  // Group mentions (@here, @channel, user groups) also count as addressing someone else.
  const groupMention = /<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)(?:\|[^>]*)?>/.test(text);
  const mentionsOthers = users.some((u) => u !== botUserId) || groupMention;
  return { mentionsBot, mentionsOthers };
}

/** "stop", "shut up", "be quiet" … addressed at the bot: short message, optionally prefixed by mentions. */
export function isStopMessage(text: string): boolean {
  const stripped = text
    .replace(USER_MENTION, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!stripped || stripped.length > 40) return false;
  return /^(?:(?:ok|okay|pls|please|hey|yo|bot|smasnug)\s+)*(?:stop(?:\s+(?:it|now|talking|replying|responding))?|shut\s*up|be\s+quiet|quiet|hush|stfu|go\s+away|enough|silence|leave\s+(?:us|me)\s+alone)(?:\s+(?:please|pls|now|bot|thanks|thx))*$/.test(
    stripped,
  );
}

/** Debounce window: longer while the thread has active subagents (people tend to steer in bursts). */
export function debounceWindowMs(hasActiveRuns: boolean, opts: { idleMs: number; busyMs: number }): number {
  return hasActiveRuns ? opts.busyMs : opts.idleMs;
}

/** Thread root for a message. DMs: each top-level message is its own thread. Channels: same rule. */
export function threadRootTs(ev: { ts: string; thread_ts?: string }): string {
  return ev.thread_ts ?? ev.ts;
}

/** Message subtypes that represent a new human/bot post (others: joins, topic changes … are ignored). */
export const NEW_MESSAGE_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast', 'bot_message', 'me_message']);
