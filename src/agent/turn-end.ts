/**
 * When a front turn ends on its own: after a step whose visible response (reply / react / unreact) went out, as long
 * as nothing else in that step still needs the model to look at its result. Saves the extra model step that used to
 * exist only to call `end_turn`. Pure, unit-tested (turn-end.test.ts).
 */
import { z } from 'zod';

/** `reply` / `react` / `unreact` end the turn when they succeed unless this is true (shared by their schemas). */
export const continueTurnSchema = z
  .boolean()
  .optional()
  .describe('Default false: once this goes out, your turn ends. true = keep working afterwards in this turn (e.g. a short ack before your own lookups).');

/** Tools whose success is the turn's response. Each takes `continue_turn` (default false) to keep the turn going. */
export const RESPONSE_TOOLS = new Set(['reply', 'react', 'unreact']);

/**
 * Tools whose result the model doesn't need to see before the turn can end: bookkeeping and fire-and-forget actions
 * (their own effect is the point, or a later turn reports back). Everything else (searches, fetches, reads,
 * ask_thread, canvas reads and writes, list_*, search_emojis, the DJ commands) is NOT terminal-safe: a step that
 * called one continues, so the model sees the result.
 */
export const TERMINAL_SAFE_TOOLS = new Set([
  'end_turn',
  'spawn_subagent',
  'message_subagent',
  'cancel_subagent',
  'spawn_coding_agent',
  'remember',
  'forget',
  'propose_workspace_fact',
  'leave_thread',
  'send_message',
  'report_user',
  'set_reminder',
  'cancel_reminder',
  'create_watch',
  'cancel_watch',
  'huddle_dj_settings',
]);

/** True when a response tool's result says it actually went out (posted / reacted / removed). */
export function responseSucceeded(toolName: string, output: unknown): boolean {
  const out = typeof output === 'string' ? output : '';
  if (toolName === 'reply') return out.startsWith('Replied');
  if (toolName === 'react') return /reacted/i.test(out);
  if (toolName === 'unreact') return out.startsWith('Removed');
  return false;
}

export interface StepCall {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

export interface StepResultPart {
  toolCallId: string;
  toolName: string;
  output: unknown;
}

const continues = (input: unknown) => Boolean(input && typeof input === 'object' && (input as { continue_turn?: unknown }).continue_turn === true);

/**
 * Should the turn end after this step? Yes when at least one response tool succeeded without `continue_turn`, no
 * response tool asked to continue, and every other call is terminal-safe and has a result (a failed spawn or send
 * must reach the model). A failed reply/react (empty, skipped, stopped) also keeps the turn going.
 */
export function endsTurnAfterStep(calls: StepCall[], results: StepResultPart[]): boolean {
  if (!calls.length) return false;
  const byId = new Map(results.map((r) => [r.toolCallId, r]));
  let responded = false;
  for (const c of calls) {
    const res = byId.get(c.toolCallId);
    if (RESPONSE_TOOLS.has(c.toolName)) {
      if (continues(c.input)) return false;
      if (!res || !responseSucceeded(c.toolName, res.output)) return false;
      responded = true;
    } else if (!TERMINAL_SAFE_TOOLS.has(c.toolName) || !res) {
      return false;
    }
  }
  return responded;
}

/** Lookup tools (lookup-guard.ts LOOKUP_TOOLS; passed in to keep this file free of that import cycle). */
type NameSet = ReadonlySet<string>;

/**
 * A final `reply` (no continue_turn) in the same step as lookups. The turn doesn't end there (lookups aren't
 * terminal-safe, so endsTurnAfterStep is false): the reply is treated as if `continue_turn` were set, and front.ts
 * adds REPLY_WITH_LOOKUPS_NOTE so the model uses the results instead of taking its reply as the end.
 */
export function replyEndsWithLookups(calls: StepCall[], lookupTools: NameSet): boolean {
  return calls.some((c) => c.toolName === 'reply' && !continues(c.input)) && calls.some((c) => lookupTools.has(c.toolName));
}

/** The note before the step after such a reply (front.ts, once per turn). */
export const REPLY_WITH_LOOKUPS_NOTE =
  "<system_note>Your reply went out in the same step as lookups, so your turn goes on: their results are above. If they change or add to what you said, send one short follow-up reply with only what's new; otherwise call end_turn.</system_note>";

/**
 * The note added before the one extra step a front turn gets when a step ended with plain text that couldn't be
 * posted as it is (decidePlainText → 'nudge'). Worded so the model sends the text as a first message, not as an
 * apology for a "lost" one.
 */
export const PLAIN_TEXT_NUDGE_NOTE =
  '<system_note>Nobody saw your last text: only tool calls reach the thread. If it was meant for the speaker, send it now with reply, as your first message to them: don\'t mention, apologise for or refer to an earlier message or draft ("above"). If no reply is needed, call end_turn.</system_note>';

/** Plain text shorter than this (or fewer than two words) is never posted as a reply. */
export const PLAIN_TEXT_MIN_CHARS = 12;
/** When something else already went out (a reaction, a spawn), plain text is only posted from this length on. */
export const PLAIN_TEXT_SUBSTANTIAL_CHARS = 60;

/** Meta text about not replying: "No reply needed.", "(no response)", "Staying silent", "end_turn". */
const META_RE =
  /^\W*(no (reply|response|answer|action|message)|nothing (to (add|say|reply|do|respond)|needed|further)|not (replying|responding|needed)|staying (silent|quiet)|silen(t|ce)|skip(ping)?\b|end(ing)? (my |the )?turn|end_turn|n\/a\b|none\b)/i;
/** Reasoning or planning rather than a message: "The user is asking…", "I should…", "Let me check…". */
const REASONING_START_RE =
  /^\W*(the (user|speaker|person)\b|the (message|thread|request|question) (is|was|seems|looks|asks|wants)\b|user (is|wants|asked|says|just)\b|they('re| are) (asking|saying|just)\b|this (message|request) (is|seems|looks)\b|i( should| need to| must| don't need| think i)\b|i('ll| will|'m going to| am going to) (call|use|spawn|reply|react|end|check|search|look|send|delegate|start|ask|respond|answer)\b|let me\b|now (i|let)\b|ok(ay)?,? (so|let me|now)\b|first,? (i|let)\b|looking at\b|based on (the|this) (context|thread|conversation)|since (the|this|they)\b|wait\b|hmm\b)/i;
/** Prompt vocabulary or a third-person "the user is/wants…": text for the bot itself, not for the thread. */
const TOOLISH_RE = /\b(end_turn|continue_turn|system_note|system note|reply tool)\b|<\/?system|\bthe (user|speaker) (is|wants|asked|says|just|seems|might|probably)\b|\b(for|to|tell) the (user|speaker)\b/i;
/** Wholly wrapped in brackets / emphasis, like "(no response)" or "*silently ends turn*". */
const WRAPPED_RE = /^\s*(\(.*\)|\[.*\]|\*[^*].*\*|_.*_)\s*$/s;

/**
 * Is plain text the model wrote (instead of calling reply) fit to post as its reply? Conservative: a message-shaped
 * text of at least two words and PLAIN_TEXT_MIN_CHARS (PLAIN_TEXT_SUBSTANTIAL_CHARS when `substantial`), and not
 * meta ("No reply needed."), reasoning ("The user wants…", "Let me check…"), tool talk or a bracketed aside.
 */
export function postablePlainText(text: string, opts: { substantial?: boolean } = {}): boolean {
  const t = text.trim();
  if (t.length < (opts.substantial ? PLAIN_TEXT_SUBSTANTIAL_CHARS : PLAIN_TEXT_MIN_CHARS)) return false;
  if (t.split(/\s+/).length < 2) return false;
  if (META_RE.test(t) || REASONING_START_RE.test(t) || TOOLISH_RE.test(t)) return false;
  if (t.length <= 200 && WRAPPED_RE.test(t)) return false;
  return true;
}

export type PlainTextAction = 'post' | 'nudge' | 'none';

/**
 * A step ended with plain text and no tool call (Claude runs with toolChoice 'auto', models.ts). What now?
 * - 'post': post the text as the reply in code and end the turn (it meant to say it). Only when no message (reply /
 *   send_message) went out this turn, the turn isn't being stopped, and the text is postable (postablePlainText;
 *   substantial when another visible effect, e.g. a reaction or a spawn, already went out).
 * - 'nudge': one more model step with PLAIN_TEXT_NUDGE_NOTE: text that isn't postable as it is, nothing visible
 *   yet, not nudged already, a step left under the limit.
 * - 'none': the turn ends (silent, or the fallback reply for a mention).
 */
export function decidePlainText(o: {
  text: string;
  toolCalls: number;
  nudged: boolean;
  /** A message (reply or send_message) is already visible this turn. */
  messaged: boolean;
  /** Any visible effect at all (reactions, spawns, steers, and messages). */
  visible: boolean;
  stopping: boolean;
  stepsUsed: number;
  maxSteps: number;
  /**
   * A reply is expected (a mention, DM, addressed follow-up or results turn). Text in an unaddressed relevance-check
   * turn is never posted ("looks like they're just chatting" would land in a conversation nobody asked the bot into):
   * it gets the nudge, which usually ends in end_turn.
   */
  expectsReply: boolean;
}): PlainTextAction {
  if (!o.text.trim() || o.toolCalls > 0 || o.stopping || o.messaged) return 'none';
  if (o.expectsReply && postablePlainText(o.text, { substantial: o.visible })) return 'post';
  if (o.visible || o.nudged || o.stepsUsed >= o.maxSteps) return 'none';
  return 'nudge';
}
