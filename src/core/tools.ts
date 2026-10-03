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
    if (def.roles.includes(role)) out[def.name] = def.build({ ...ctx, role });
  }
  return out;
}

export function registeredTools() {
  return [...registry.values()].map((d) => ({ name: d.name, roles: d.roles }));
}
