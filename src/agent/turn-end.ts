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
  'set_card_title',
  'set_session_title',
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
