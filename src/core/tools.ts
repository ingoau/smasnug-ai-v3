/**
 * Shared tool registry. Three roles are granted tools from here; safety comes from what each role is given,
 * not from prompts. Modules call `registerTool` at import time; `src/tools/index.ts` imports them all.
 */
import type { Tool } from 'ai';

export type Role = 'gate' | 'front' | 'child';

/** Per-invocation context handed to every tool factory. */
export interface ToolContext {
  role: Role;
  threadId: string;
  channelId: string;
  threadTs: string;
  /** Current speaker (front agent) or the subagent owner (children). */
  speakerId: string;
  turnId?: number;
  subagentId?: string;
  runId?: number;
  abortSignal?: AbortSignal;
  /** Free-form per-role extras (e.g. the front agent's reply streamer). Keys are owned by the module that sets them. */
  extras: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  roles: Role[];
  build: (ctx: ToolContext) => Tool;
}

const registry = new Map<string, ToolDef>();

export function registerTool(def: ToolDef) {
  if (registry.has(def.name)) throw new Error(`tool ${def.name} registered twice`);
  registry.set(def.name, def);
}

export function toolsFor(role: Role, ctx: Omit<ToolContext, 'role'>): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const def of registry.values()) {
    if (def.roles.includes(role)) out[def.name] = abortGuarded(def.build({ ...ctx, role }), ctx.abortSignal);
  }
  return out;
}

/** What a tool call returns when its turn / run was stopped before the tool started. */
export const STOPPED_TOOL_RESULT = 'Not done: this was stopped before the tool ran.';

/**
 * Every tool checks the stop signal before acting: a call whose turn (`!stop`) or run (cancel, timeout) was aborted
 * never starts its side effects (the AI SDK may still dispatch a call it parsed just before the abort). Tools with
 * several side effects, or long waits, also get the signal (ctx.abortSignal / the execute options) to stop midway.
 */
function abortGuarded(t: Tool, signal: AbortSignal | undefined): Tool {
  const execute = (t as { execute?: (input: unknown, options: any) => unknown }).execute;
  if (!execute) return t;
  return {
    ...t,
    execute: (input: unknown, options: any) => {
      if (signal?.aborted || options?.abortSignal?.aborted) return STOPPED_TOOL_RESULT;
      return execute.call(t, input, options);
    },
  } as Tool;
}

export function registeredTools() {
  return [...registry.values()].map((d) => ({ name: d.name, roles: d.roles }));
}
