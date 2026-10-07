/**
 * Whether a front turn gets <channel_background> (the top-level channel messages around the thread parent). Pure;
 * unit-tested in channel-background.test.ts. The relevance gate has its own context and doesn't use this.
 *
 * Background only helps when the conversation is (still) about something outside the thread: the thread has just
 * started (a top-level message or a few replies), or the new message points at something ("this", "^", "above",
 * "what do you think", "thoughts?", a bare ping…). In a longer thread it's other people's unrelated chatter.
 */

const MENTION = /<@[UW][A-Z0-9]+(?:\|[^>]*)?>|<!(?:here|channel|everyone)(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/g;

/** Phrases that point at something said elsewhere, anywhere in the message. */
const POINTING = [
  /(^|\s)\^+(\s|[?!.]|$)/, // "^", "^^ this"
  /\babove\b/i,
  /\bup there\b/i,
  /\b(the|that|this) (last |previous |earlier )?(message|msg|post|announcement|thread|link|screenshot|pic|image|one)\b/i,
  /\b(last|previous) (message|msg|post)\b/i,
  /\bwhat do (you|u|ya) (think|reckon|make of)\b/i,
  /\b(wdyt|thoughts\s*\?|any thoughts|your thoughts|thoughts on (this|that|it))/i,
  /\b(agree|true|real|legit|accurate|correct|right)\s*\?/i,
  /\bis (this|that|it) (true|real|legit|accurate|correct|right|a scam|safe)\b/i,
  /\b(fact[- ]?check|context\s*\?|source\s*\?|explain (this|that|it)|what does (this|that) mean|what('s| is) (this|that) about|tl;?dr)\b/i,
];

/** A short message (after mentions) that uses a pointing word, e.g. "this??", "lol is that real", "explain pls this". */
const SHORT_DEICTIC = /\b(this|that|these|those)\b/i;
const SHORT_WORDS = 8;

/** The text of a message without mentions, trimmed. */
function strip(text: string): string {
  return text.replace(MENTION, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the message points at something outside it (or is a bare ping, "hey, look at this"). */
export function pointsAtSomething(text: string, hasFiles = false): boolean {
  const t = strip(text);
  if (!t.replace(/[\s.,!?]+/g, '')) return !hasFiles; // bare ping
  if (POINTING.some((re) => re.test(t))) return true;
  return t.split(' ').length <= SHORT_WORDS && SHORT_DEICTIC.test(t);
}

export function wantsChannelBackground(opts: {
  /** Replies already in the thread before this turn's new messages (0 for a new top-level message). */
  priorReplies: number;
  /** This turn's new messages. Empty for synthesis / scheduled turns. */
  newMessages: { text: string; hasFiles?: boolean }[];
  /** Threads with at most this many prior replies always get the background. */
  maxReplies: number;
}): boolean {
  if (opts.priorReplies <= opts.maxReplies) return true;
  return opts.newMessages.some((m) => pointsAtSomething(m.text, m.hasFiles));
}
