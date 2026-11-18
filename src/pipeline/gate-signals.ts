/**
 * Deterministic adjustments around the relevance gate's score, from what the gate already sees (the thread's recent
 * messages and the new batch). The decisions model alone missed follow-up questions right after the bot's own
 * answer, and answered messages addressed to another person (prod, Nov 2026). These nudge its probability a little in
 * the direction the thread's shape clearly points; the model still decides everything in between.
 *
 * Kept modest on purpose: a boost only helps a borderline score over the threshold, a dampen pulls one under it.
 * Every applied signal is logged in the `gate_decision` event (fire.ts) so the deltas can be evaluated and tuned.
 */
import type { StoredMessage } from '../core/types.js';

export type GateSignal = 'follows_bot' | 'mentions_other_leading' | 'mentions_other' | 'addressed_by_name';

export interface GateAdjustment {
  /** Added to the decisions model's probability (then clamped to 0..1). */
  delta: number;
  signals: GateSignal[];
}

/**
 * The bot's own message is the most recent one by anyone other than the batch's author, and the batch asks or requests
 * something: a follow-up to the bot's answer. +0.1 lifts a borderline score (e.g. 0.6 against the 0.65 partner
 * threshold) without letting a clear "no" (0.3) through.
 */
const FOLLOWS_BOT_BOOST = 0.1;
/** The message starts with an @mention of another person (or a user group): it's addressed to them. */
const MENTION_LEADING_DAMPEN = -0.25;
/** Another person is @mentioned somewhere in it (could be "ask @X", so weaker). */
const MENTION_OTHER_DAMPEN = -0.1;
/**
 * Starts like "Sam, …" / "hey Sam …" where Sam is a known human in the thread (or someone @mentioned in it), not the
 * bot: addressed to someone else. Only known names count: "Error: …", "TLDR: …", "hi there, …" aren't names.
 */
const NAME_ADDRESS_DAMPEN = -0.15;

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/g;
const LEADING_MENTION_RE = /^\s*(?:(?:hey|hi|yo|ok|okay|so)[,\s]+)?(?:<@([UW][A-Z0-9]+)(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>)/i;
/** A question or a request: worth a boost after the bot's answer. A remark ("7 is the best one") isn't. */
const QUESTION_RE = /\?|^\s*(?:what|how|why|when|where|who|which|can|could|would|will|do|does|did|is|are|should|please|pls|explain|tell|show|give|make|try|write|add|list|find|check|now|and|also|what's|whats|how's)\b/i;
/** Words that start a sentence followed by a comma but aren't names ("ok, …", "Thanks, …"). */
const NOT_NAMES = new Set(
  'ok okay so yes yeah yep no nah nope hey hi hello yo well also thanks thank thx ty lol lmao wait hmm hm btw oh ah right sure cool nice great anyway anyways alright and but or then fine true agreed please pls sorry same wow damn tbh imo idk ngl fyi note edit update ps plus also question idea context result results guys everyone all folks team bro dude man'.split(' '),
);

/** This bot's own message (store.ts isTwoPartyThread's test): a webhook or another app's bot message isn't. */
function isOwnBot(m: StoredMessage, bot: { userId: string; botId?: string | null }): boolean {
  return m.userId === bot.userId || (!!bot.botId && m.botId === bot.botId);
}

/** Lowercased, with `-`/`_`/`.` as spaces: "smasnug-ai" and "Smasnug_AI" compare equal to "smasnug ai". */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure: the name keys a person can be addressed by (normalised): each of their display name, real name and handle,
 * and the first word of each ("Sam" for "Sam Smith").
 */
export function nameKeys(p: { displayName?: string | null; realName?: string | null; handle?: string | null }): string[] {
  const out = new Set<string>();
  for (const raw of [p.displayName, p.realName, p.handle]) {
    const n = normalizeName(raw ?? '');
    if (n.length < 2) continue;
    out.add(n);
    const first = n.split(' ')[0]!;
    if (first.length >= 2) out.add(first);
  }
  return [...out];
}

/**
 * Pure: the human users the gate's messages involve, apart from the author and the bot: who wrote in the context or
 * batch, and who is @mentioned there. Their names are what "Sam, …" can refer to (fire.ts looks them up).
 */
export function gateParticipantIds(o: { context: StoredMessage[]; newMessages: StoredMessage[]; botUserId: string; authorId: string | null }): string[] {
  const ids = new Set<string>();
  for (const m of [...o.context, ...o.newMessages]) {
    if (m.userId && !m.botId) ids.add(m.userId);
    for (const x of (m.text ?? '').matchAll(MENTION_RE)) if (x[1]) ids.add(x[1]);
  }
  ids.delete(o.botUserId);
  if (o.authorId) ids.delete(o.authorId);
  return [...ids];
}

/** Human (or user-group) mentions in `text` that aren't the bot or the author. */
export function otherMentions(text: string, botUserId: string, authorId: string | null): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const id = m[1];
    if (id && (id === botUserId || id === authorId)) continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * "Sam, can you…", "sam: …", "hey Sam can you…": a leading name of one of `knownNames` (nameKeys of the thread's
 * other humans) that isn't the bot's. Null when none.
 */
export function leadingName(text: string, botName: string, knownNames: Iterable<string>): string | null {
  const known = knownNames instanceof Set ? (knownNames as Set<string>) : new Set(knownNames);
  if (known.size === 0) return null;
  const t = text.trim();
  const m = /^(?:(?:hey|hi|hello|yo|ok|okay)\s+)?([A-Za-z][\w.'-]{1,30})\s*[,:]/i.exec(t) ?? /^(?:hey|hi|hello|yo)\s+([A-Za-z][\w.'-]{1,30})\b/i.exec(t);
  if (!m) return null;
  const name = m[1]!.replace(/[.'-]+$/, '');
  const key = normalizeName(name);
  if (!key || NOT_NAMES.has(key) || (key.length >= 6 && key.endsWith('ly'))) return null; // "honestly, …", "basically, …"
  const bot = normalizeName(botName);
  if (bot === key || bot.split(' ').includes(key) || key.split(' ').every((w) => bot.split(' ').includes(w))) return null;
  return known.has(key) ? name : null;
}

/**
 * Pure: the signals and the total delta for one gated batch. `context` is the thread's recent messages before the
 * batch (oldest first), as the gate gets them.
 */
export function gateAdjustment(o: {
  context: StoredMessage[];
  newMessages: StoredMessage[];
  botUserId: string;
  /** This bot's bot id (auth.test): a message counts as the bot's by either id. */
  botId?: string | null;
  botName: string;
  /** nameKeys of the thread's other humans (gateParticipantIds); without them no name counts as addressing someone. */
  participantNames?: Iterable<string>;
}): GateAdjustment {
  const signals: GateSignal[] = [];
  const texts = o.newMessages.map((m) => m.text ?? '');
  const authorId = o.newMessages[0]?.userId ?? null;
  // An explicit mention of the bot never reaches the gate; if one does, leave the model's call alone.
  if (texts.some((t) => t.includes(`<@${o.botUserId}`))) return { delta: 0, signals };

  let delta = 0;
  const leading = texts.some((t) => {
    const m = LEADING_MENTION_RE.exec(t);
    return !!m && m[1] !== o.botUserId && m[1] !== authorId;
  });
  const mentionsOther = texts.some((t) => otherMentions(t, o.botUserId, authorId).length > 0);
  const known = new Set(o.participantNames ?? []);
  const named = !leading && texts.some((t) => leadingName(t, o.botName, known) != null);
  if (leading) {
    signals.push('mentions_other_leading');
    delta += MENTION_LEADING_DAMPEN;
  } else if (mentionsOther) {
    signals.push('mentions_other');
    delta += MENTION_OTHER_DAMPEN;
  }
  if (named) {
    signals.push('addressed_by_name');
    delta += NAME_ADDRESS_DAMPEN;
  }

  // Boost only when nothing points at someone else.
  if (!leading && !mentionsOther && !named) {
    const lastOther = [...o.context].reverse().find((m) => m.userId !== authorId);
    if (lastOther && isOwnBot(lastOther, { userId: o.botUserId, botId: o.botId }) && texts.some((t) => QUESTION_RE.test(t))) {
      signals.push('follows_bot');
      delta += FOLLOWS_BOT_BOOST;
    }
  }
  return { delta: Math.round(delta * 1000) / 1000, signals };
}

export function applyAdjustment(p: number, a: GateAdjustment): number {
  return Math.min(1, Math.max(0, p + a.delta));
}
