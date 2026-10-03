/**
 * Code-level guards for front-agent behaviour (the prompt asks for the same; these make it hold):
 * - reactions replace replies: at most one reaction per turn, none once the turn replied, and a reaction is taken
 *   back if the turn replies after all;
 * - after delegating (spawn / resume) a user turn does no lookups of its own and posts at most one acknowledgement.
 */
import type { Tool } from 'ai';
import { appendEvent } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { log } from '../log.js';
import { syncOwnReaction } from '../tools/emoji.js';
import { WEB_SEARCH_TOOL } from '../tools/web-search.js';
import type { FrontTurnState } from './turn-state.js';

export const REACT_AFTER_REPLY = 'Not reacted: you already replied this turn. Reactions only replace replies, never accompany them.';
export const REACT_CAP = 'Already reacted this turn.';
export const REPLY_REPEATED = "Not posted: you already replied and nothing new has happened since. End your turn.";
export const REPLY_AFTER_DELEGATION =
  'Not posted: you already replied in this turn and the plan card shows the delegated work. End your turn now; the results come back in a separate turn where you write the answer.';

/** Tools a turn may no longer use once it has delegated: the subagent does the looking up. */
export const LOOKUP_TOOLS = new Set([WEB_SEARCH_TOOL, 'fetch_url', 'read_thread', 'read_channel', 'slack_search', 'read_image']);
/** Tool calls that make up an acknowledgement step after delegating. */
const ACK_TOOLS = new Set(['reply', 'react', 'spawn_subagent', 'message_subagent']);

/** Remove the reaction this turn added (best effort). */
export async function retractReaction(s: FrontTurnState): Promise<void> {
  const r = s.reaction;
  if (!r) return;
  s.reaction = null;
  try {
    await slackCall('reactions.remove', { channel: s.channelId, timestamp: r.ts, name: r.emoji }, { idempotencyKey: `unreact:${s.turn.id}:${r.ts}:${r.emoji}` });
    await appendEvent(s.threadId, 'reaction_removed', 'bot', { emoji: r.emoji, ts: r.ts, turnId: s.turn.id });
    await syncOwnReaction(s.channelId, r.ts, 'removed', r.emoji);
  } catch (err) {
    log.debug({ err, reaction: r }, 'reactions.remove failed');
  }
}

/** Wrap the `react` tool with the per-turn rules. Records the reaction on the turn state. */
export function guardReact(tools: Record<string, Tool>, s: FrontTurnState): void {
  const orig = tools.react;
  const exec = orig?.execute;
  if (!orig || !exec) return;
  tools.react = {
    ...orig,
    execute: async (input: any, options: any) => {
      if (s.replies.attempted) return REACT_AFTER_REPLY;
      if (s.reactions >= 1) return REACT_CAP;
      s.reactions++;
      const out = String(await exec(input, options));
      const m = /Reacted :(.+?): to (\d+\.\d+)\./.exec(out);
      if (m) {
        s.reaction = { emoji: m[1]!, ts: m[2]! };
        s.visible.add('react');
        // A reply may have been delivered while the reaction was being added.
        if (s.replies.delivered > 0) await retractReaction(s);
        else return `${out} The reaction is your whole response; end your turn.`;
      } else if (/already reacted/i.test(out)) {
        s.visible.add('react');
      } else {
        s.reactions--; // nothing was added; another attempt is fine
      }
      return out;
    },
  } as Tool;
}

/** Why a new reply must not be delivered in this turn, if anything. */
export function replyBlockReason(s: FrontTurnState): string | null {
  if (s.replies.delivered < 1) return null;
  if (s.afterReplyOnlyStep) return REPLY_REPEATED;
  return s.turn.kind === 'user' && s.delegated ? REPLY_AFTER_DELEGATION : null;
}

/** True for a step whose tool calls were only reply/react, with at least one reply. */
export function isReplyOnlyStep(toolNames: string[] | undefined): boolean {
  return !!toolNames?.length && toolNames.includes('reply') && toolNames.every((n) => n === 'reply' || n === 'react');
}

/**
 * Stop condition: the step delivered the turn's answer — its tool calls were only reply / react (and
 * set_card_title in a synthesis, or the silent report_user), with at least one reply. Ending here saves a wrap-up model call that almost
 * always just ends the turn (or repeats the reply). The caller checks for new inbox messages first.
 */
export function isFinalReplyStep(toolNames: string[] | undefined): boolean {
  return !!toolNames?.length && toolNames.includes('reply') && toolNames.every((n) => n === 'reply' || n === 'react' || n === 'set_card_title' || n === 'report_user');
}

/**
 * True when a reply reads like "on it / let me check / one sec": the model announced work it hasn't started (it
 * sometimes acknowledges first and calls spawn_subagent / a lookup in the next step). Such a step is not the end of
 * the turn. Deliberately broad: a false positive only costs the wrap-up model call we'd otherwise skip.
 */
export function announcesMoreWork(text: string): boolean {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  if (t.length > 300) return false; // an acknowledgement is short; a long reply is the answer
  // Unambiguous anywhere in the reply…
  if (STRONG_ACK.test(t)) return true;
  // …while words like "searching" / "checking" also describe capabilities ("i can search slack, check docs…"),
  // so they only count at the start of a sentence.
  return WEAK_ACK.test(t);
}

const STRONG_ACK =
  /\b(on it|let me(?! know)|lemme|let's see|one (?:sec|moment|min)|give me (?:a )?(?:sec|second|moment|min|minute|bit)|hang on|hold on|brb|working on it|spinning up|kicking off|looking into (?:it|this|that)|i'll (?:go |quickly |just )?(?:look|check|dig|research|find|search|get back|pull|ask|spin|kick|take a look|read|grab|see)|i'm (?:going to|gonna) (?:look|check|dig|research|find|search|pull|ask|spin|kick|read|grab|see)|gonna (?:look|check|dig|research|search|find))\b/;
const WEAK_ACK =
  /(?:^|[.!?\n]\s*)(?:(?:ok(?:ay)?|sure(?: thing)?|yep|yeah|yes|cool|alright|got it|gotcha|bet|hmm+|ooh|oh)[,!. ]+\s*)*(?:checking|searching|researching|looking|digging|starting)\b/;

/** Stop condition: a user turn that delegated and acknowledged is done once a step only acknowledged / delegated. */
export function delegatedAndAcknowledged(s: FrontTurnState, lastStepToolNames: string[] | undefined): boolean {
  if (s.turn.kind !== 'user' || !s.delegated || s.replies.delivered < 1 || !lastStepToolNames?.length) return false;
  return lastStepToolNames.every((n) => ACK_TOOLS.has(n));
}

/** Stop condition: a step that only reacted (successfully) was the whole response. */
export function reactedAsResponse(s: FrontTurnState, lastStepToolNames: string[] | undefined): boolean {
  return !!s.reaction && !!lastStepToolNames?.length && lastStepToolNames.every((n) => n === 'react');
}

/** Active tools for the next step. `undefined` = all. */
export function activeToolsFor(s: FrontTurnState, toolNames: string[], opts: { searchOverLimit: boolean }): string[] | undefined {
  let names = toolNames;
  if (opts.searchOverLimit) names = names.filter((n) => n !== WEB_SEARCH_TOOL);
  if (s.delegated) names = names.filter((n) => !LOOKUP_TOOLS.has(n));
  return names.length === toolNames.length ? undefined : names;
}
