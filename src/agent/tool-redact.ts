/**
 * Tool inputs that hold secrets (docs/vault.md, "Keeping secrets away from the model"). The model passed them in its
 * call, but they must never be persisted or shown again: the `turn_tools` thread event (and so the next turn's
 * <previous_turn_tools>), traces and eval exports, a subagent's stored history, logs. Every place that stores or shows
 * a tool call's input runs it through redactToolInput first.
 */

export const REDACTED = '[redacted]';

/** Tool name → input fields that are secrets. */
const SECRET_INPUTS = new Map<string, readonly string[]>([['save_credential', ['value', 'password', 'totp']]]);

/** Declare secret input fields for a tool (another module's tool). */
export function registerSecretInputs(toolName: string, fields: readonly string[]): void {
  SECRET_INPUTS.set(toolName, [...new Set([...(SECRET_INPUTS.get(toolName) ?? []), ...fields])]);
}

export function hasSecretInputs(toolName: string): boolean {
  return SECRET_INPUTS.has(toolName);
}

/**
 * The input with its secret fields replaced by "[redacted]". An input of a secret-taking tool that isn't a plain
 * object (e.g. the raw text of a call whose JSON didn't parse) is redacted whole.
 */
export function redactToolInput(toolName: string, input: unknown): unknown {
  const fields = SECRET_INPUTS.get(toolName);
  if (!fields || input == null) return input;
  if (typeof input !== 'object' || Array.isArray(input)) return REDACTED;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const f of fields) if (out[f] != null && out[f] !== '') out[f] = REDACTED;
  return out;
}
