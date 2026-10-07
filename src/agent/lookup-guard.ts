/**
 * Lookup guard for the front agent: a code-side backstop for "answer directly or delegate". The prompt tells the front
 * agent to do at most one or two quick lookups itself and hand anything bigger to subagents, but a model that keeps
 * researching on its own (prod/live: a dozen web searches for a staged research request, no spawn_subagent) only
 * stops at the step limit. So, per front turn:
 * - after `limits.frontLookupNudgeSteps` lookup-only steps, a short note asks it to delegate (or answer) now;
 * - after `limits.frontLookupRestrictSteps` more, the research tools are switched off for the rest of the turn
 *   (prepareStep `activeTools`), leaving reply, spawn_subagent and the other non-research tools.
 * A normal answer with one or two lookups never reaches either. Subagents (child.ts) don't use this. Pure, unit-tested
 * (lookup-guard.test.ts).
 */
import { RESPONSE_TOOLS } from './turn-end.js';

/** Research tools: reads and searches whose result the model gathers itself (what subagents are for). */
export const LOOKUP_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'slack_search',
  'slack_semantic_search',
  'ask_thread',
  'read_thread',
  'read_channel',
  'read_public_channel',
  'read_public_thread',
  'read_canvas',
  'read_file',
  'ask_file',
]);

/**
 * Calls that may sit next to lookups without making the step anything but a lookup step: an ack reply / reaction
 * (`continue_turn`) and trivia. A step that also spawns, sends or creates something is not a lookup step.
 */
const NEUTRAL_TOOLS = new Set([...RESPONSE_TOOLS, 'search_emojis', 'set_session_title']);

/** A lookup step: at least one research call, and nothing else but neutral calls. */
export function isLookupStep(toolNames: readonly string[]): boolean {
  let lookups = 0;
  for (const name of toolNames) {
    if (LOOKUP_TOOLS.has(name)) lookups++;
    else if (!NEUTRAL_TOOLS.has(name)) return false;
  }
  return lookups > 0;
}

/** How many of the turn's steps so far were lookup steps (each step given as its tool names). */
export function countLookupSteps(steps: readonly (readonly string[])[]): number {
  return steps.filter(isLookupStep).length;
}

export type LookupGuard = 'none' | 'nudge' | 'restrict';

/** What the guard does before the next step, given the lookup steps so far. */
export function lookupGuard(lookupSteps: number, opts: { nudgeAfter: number; restrictAfter: number }): LookupGuard {
  if (opts.nudgeAfter <= 0) return 'none';
  if (lookupSteps >= opts.nudgeAfter + Math.max(0, opts.restrictAfter)) return 'restrict';
  if (lookupSteps >= opts.nudgeAfter) return 'nudge';
  return 'none';
}

/** The note injected once when the guard first nudges. */
export function lookupNudgeNote(lookupSteps: number): string {
  return `<system_note>You've done ${lookupSteps} rounds of lookups yourself in this turn. Per your rules, stop researching yourself: hand the rest to subagents now with spawn_subagent (one call, several tasks if there are several things to dig into) together with a short reply saying what's next, or reply with the answer if you already have enough.</system_note>`;
}

/** The note injected once when the research tools are switched off. */
export const LOOKUP_RESTRICT_NOTE =
  "<system_note>Research tools are now off for the rest of this turn. Delegate what's left with spawn_subagent (plus a short reply saying what's next), or reply with what you have.</system_note>";

/** The tools still offered once research is off: everything but the research tools. */
export function nonLookupTools(toolNames: readonly string[]): string[] {
  return toolNames.filter((n) => !LOOKUP_TOOLS.has(n));
}
