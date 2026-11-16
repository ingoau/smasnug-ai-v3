/**
 * Button actions: tool calls a reply can bind to an `action` button (reply-buttons.ts), run by code when the button is
 * pressed, with no model in the loop. Only actions registered here can be bound (an allowlist): each module registers
 * the ones it owns next to the tool (e.g. upload_emoji in src/tools/emoji-files.ts).
 *
 * The arguments are fixed when the reply goes out: `prepareButtonActions` parses and checks them then (an action that
 * fails the check becomes a plain prompt button and the reply tool's result says why), and `runButtonAction` checks
 * them again on the press (things change in between) before running. Who pressed is the speaker of the run: limits and
 * access checks apply to them.
 */
import type { z } from 'zod';
import { log } from '../log.js';
import { buttonWho, type ButtonOutcome, type ButtonResponse } from './reply-buttons.js';

export interface ButtonActionContext {
  threadId: string;
  channelId: string;
  /** At prepare time: the person the reply answers. At press time: who pressed. */
  speakerId: string;
  /** Unique per press of one button (idempotency for the side effect). Absent at prepare time. */
  key?: string;
}

export interface ButtonActionDef<A = any> {
  /** The tool name the model refers to (`action.tool`). */
  name: string;
  args: z.ZodType<A>;
  /** Null when the action can run with these arguments, else why not (said to the model / the presser). */
  check(ctx: ButtonActionContext, args: A): Promise<string | null>;
  run(ctx: ButtonActionContext & { key: string }, args: A): Promise<ButtonOutcome>;
}

const actions = new Map<string, ButtonActionDef>();

export function registerButtonAction<A>(def: ButtonActionDef<A>): void {
  if (actions.has(def.name)) throw new Error(`button action ${def.name} registered twice`);
  actions.set(def.name, def as ButtonActionDef);
}

export function buttonActionNames(): string[] {
  return [...actions.keys()];
}

type Parsed = { def: ButtonActionDef; args: unknown } | { error: string };

function parse(r: Extract<ButtonResponse, { kind: 'action' }>): Parsed {
  const def = actions.get(r.tool);
  if (!def) {
    const names = buttonActionNames();
    return { error: `"${r.tool}" can't run from a button${names.length ? ` (button actions: ${names.join(', ')})` : ' (no button actions are available)'}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(r.args);
  } catch {
    return { error: 'its args are not valid JSON' };
  }
  const args = def.args.safeParse(raw);
  if (!args.success) return { error: `its args don't fit ${def.name}: ${args.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}` };
  return { def, args: args.data };
}

/**
 * Check the action buttons of a reply about to go out. An action that can't run becomes a prompt button (keeping its
 * `who`), with a note for the model.
 */
export async function prepareButtonActions(labels: readonly string[], responses: readonly (ButtonResponse | null)[], ctx: ButtonActionContext): Promise<{ responses: (ButtonResponse | null)[]; notes: string[] }> {
  const notes: string[] = [];
  const out = await Promise.all(
    responses.map(async (r, i) => {
      if (r?.kind !== 'action') return r;
      const p = parse(r);
      let problem = 'error' in p ? p.error : null;
      if (!problem && !('error' in p)) {
        problem = await p.def.check(ctx, p.args).catch((err) => {
          log.warn({ err, action: r.tool }, 'button action check failed');
          return 'it could not be checked';
        });
      }
      if (!problem) return r;
      notes.push(`Button "${labels[i]}" can't run ${r.tool}: ${problem}. It starts a turn like a normal button instead.`);
      return buttonWho(r) === 'requester' ? ({ kind: 'prompt', who: 'requester' } as const) : null;
    }),
  );
  return { responses: out, notes };
}

/** Run an action button's bound call for a press. Never throws: a failure is an outcome with ok = false. */
export async function runButtonAction(r: Extract<ButtonResponse, { kind: 'action' }>, ctx: ButtonActionContext & { key: string }): Promise<ButtonOutcome> {
  const p = parse(r);
  if ('error' in p) return { ok: false, text: `Can't run ${r.tool}: ${p.error}.` };
  try {
    const problem = await p.def.check(ctx, p.args);
    if (problem) return { ok: false, text: problem };
    return await p.def.run(ctx, p.args);
  } catch (err) {
    log.warn({ err, action: r.tool, threadId: ctx.threadId }, 'button action failed');
    return { ok: false, text: `${r.tool} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
