/**
 * Pure decision logic for "When the bot responds" (design doc). No I/O, no config imports: everything is passed in
 * so it can be unit-tested directly.
 */

/**
 * Why a message joins a debounce batch.
 * - 'dm' / 'mention': always runs (no gate).
 * - 'direct': the author answers the bot's own question / offer (awaitedReply): runs without the gate.
 * - 'partner': a two-party thread, or the bot's latest conversation partner continuing with nobody else in between:
 *   through the gate at the lower partner threshold (gateThreshold).
 * - 'gate': through the gate at the normal (or cooling) threshold.
 */
export type BatchReason = 'dm' | 'mention' | 'direct' | 'partner' | 'gate';

export type Decision =
  | { action: 'ignore'; reason: 'bot' | 'not_engaged' | 'mentions_other' | 'disengaged' | 'unsupported' | 'quiet' }
  | { action: 'batch'; reason: BatchReason };

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
  /**
   * The author is the bot's most recent conversation partner (the speaker its latest reply was for) and nobody else
   * has written since that reply.
   */
  partner?: boolean;
  /**
   * The bot's latest message ended with a question, an offer or quick-reply buttons for this author, and this is
   * their first message since: runs without the gate, regardless of idle time or disengagement.
   */
  awaitedReply?: boolean;
  /** Text starts with `<>` (guidelines rule 4): never answered unless the bot is @mentioned. */
  quietPrefix?: boolean;
}

export function decide(f: MessageFacts): Decision {
  if (f.isBot) return { action: 'ignore', reason: 'bot' };
  if (f.quietPrefix && !f.mentionsBot) return { action: 'ignore', reason: 'quiet' };
  if (f.isDm) return { action: 'batch', reason: 'dm' };
  if (f.mentionsBot) return { action: 'batch', reason: 'mention' };
  if (f.awaitedReply && !f.mentionsOthers) return { action: 'batch', reason: 'direct' };
  if (!f.engaged) return { action: 'ignore', reason: 'not_engaged' };
  if (f.disengageDue) return { action: 'ignore', reason: 'disengaged' };
  if (f.mentionsOthers) return { action: 'ignore', reason: 'mentions_other' };
  if (f.twoParty || f.partner) return { action: 'batch', reason: 'partner' };
  return { action: 'batch', reason: 'gate' };
}

const GATED = new Set<BatchReason>(['gate', 'partner']);

/** A batch runs the front agent without the gate if any of its messages had a deterministic reason. */
export function batchNeedsGate(reasons: BatchReason[]): boolean {
  return reasons.length > 0 && reasons.every((r) => GATED.has(r));
}

/**
 * Not a mention, but framed as addressed to the bot ("talking with you"): an answer to its question / offer, or a
 * partner follow-up (only reaches a turn after passing the gate).
 */
export function batchIsAddressed(reasons: BatchReason[]): boolean {
  return reasons.some((r) => r === 'direct' || r === 'partner');
}

/** Mention/DM turns get the status indicator. */
export function batchIsMention(reasons: BatchReason[]): boolean {
  return reasons.some((r) => r === 'dm' || r === 'mention');
}

export interface EngagementState {
  /** Count of human messages since the bot was last addressed, including the current one. */
  messagesSinceAddressed: number;
  lastAddressedAt: Date | null;
  /** Any bot reply (also synthesis / scheduled turns) counts as activity for the idle clock. */
  lastBotReplyAt?: Date | null;
}

/** When the thread last saw the bot in action: addressed, or the bot's latest reply. Null if neither is known. */
export function lastEngagedAt(s: Pick<EngagementState, 'lastAddressedAt' | 'lastBotReplyAt'>): Date | null {
  const a = s.lastAddressedAt?.getTime() ?? null;
  const b = s.lastBotReplyAt?.getTime() ?? null;
  if (a == null && b == null) return null;
  return new Date(Math.max(a ?? -Infinity, b ?? -Infinity));
}

/**
 * Full disengagement: more than `afterMessages` unaddressed human messages, or idle (no address, no bot reply) for
 * longer than `afterMs` (days; a few idle hours only make the gate stricter, see isCooling).
 */
export function shouldDisengage(s: EngagementState, now: Date, opts: { afterMessages: number; afterMs: number }): boolean {
  if (s.messagesSinceAddressed > opts.afterMessages) return true;
  const last = lastEngagedAt(s);
  if (last && now.getTime() - last.getTime() > opts.afterMs) return true;
  return false;
}

/** The thread is cooling: idle (no address, no bot reply) for more than `afterMs`. The gate then needs more. */
export function isCooling(s: Pick<EngagementState, 'lastAddressedAt' | 'lastBotReplyAt'>, now: Date, afterMs: number): boolean {
  const last = lastEngagedAt(s);
  return Boolean(last && now.getTime() - last.getTime() > afterMs);
}

/**
 * The gate's respond threshold for a batch. A partner batch (two-party thread, or the bot's latest conversation
 * partner continuing) gets the low threshold, even in a cooling thread (nobody else spoke since the bot did); a
 * cooling thread gets the high one; everything else the base GATE_THRESHOLD.
 */
export function gateThreshold(f: { partner: boolean; cooling: boolean }, t: { base: number; partner: number; cooling: number }): number {
  if (f.partner) return t.partner;
  if (f.cooling) return t.cooling;
  return t.base;
}

/** Offer phrasings at the end of a reply that expect an answer even without a question mark. */
const OFFER = /\b(want me to|should i|shall i|if you want|if you'd like|if you like|just say the word|say the word|lmk if|let me know if)\b/i;

/**
 * Does the bot's reply wait for an answer? True when it has quick-reply buttons, its text ends with a question
 * (trailing "?", also before closing punctuation, emoji codes or a code fence), or its last sentence is an offer.
 */
export function awaitsReply(text: string, hasButtons = false): boolean {
  if (hasButtons) return true;
  const t = text
    .trim()
    .replace(/(?:\s*:[a-z0-9_+'-]+:)+$/i, '') // trailing emoji codes
    .replace(/[\s)\]"'*_~`]+$/, '');
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const last = t.split(/(?<=[.!?])\s+|\n+/).filter(Boolean).at(-1) ?? '';
  return OFFER.test(last);
}

/** Slackbot's user id: its system messages ("you were added to a user group…") never start anything. */
export const SLACKBOT_USER_ID = 'USLACKBOT';
export const isSlackbotUser = (userId: string | null | undefined) => userId === SLACKBOT_USER_ID;

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


/**
 * Debounce window: longer while the thread has active subagents (people tend to steer in bursts). Messages that run
 * the front agent without the gate (DM, mention, two-party follow-up, stop) use the short `directMs` window when
 * given: the reply should start fast, and a same-author follow-up that misses the window still reaches the running
 * turn through its inbox. Gate-bound messages keep `idleMs` (merging saves a gate call and a turn).
 */
export function debounceWindowMs(hasActiveRuns: boolean, opts: { idleMs: number; busyMs: number; directMs?: number }, reason?: BatchReason): number {
  if (hasActiveRuns) return opts.busyMs;
  if (reason && reason !== 'gate' && opts.directMs != null) return opts.directMs;
  return opts.idleMs;
}

/** Thread root for a message. DMs: each top-level message is its own thread. Channels: same rule. */
export function threadRootTs(ev: { ts: string; thread_ts?: string }): string {
  return ev.thread_ts ?? ev.ts;
}

/** Order Slack timestamps ("1700000000.000100") exactly, without float rounding. */
export function compareTs(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  if (ai.length !== bi.length) return ai.length - bi.length;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const fa = af.padEnd(6, '0');
  const fb = bf.padEnd(6, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/** Message subtypes that represent a new human/bot post (others: joins, topic changes … are ignored). */
export const NEW_MESSAGE_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast', 'bot_message', 'me_message']);
