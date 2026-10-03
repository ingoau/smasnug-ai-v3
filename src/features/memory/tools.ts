/**
 * Memory tools for the front agent. None of them take a user id: the user is always ctx.speakerId.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool, type ToolContext } from '../../core/tools.js';
import { appendEvent } from '../../core/events.js';
import { log } from '../../log.js';
import { proposeWorkspaceFact, WS_FACT_MAX_CHARS } from '../workspace.js';
import {
  addFact,
  cleanFactText,
  countFacts,
  deleteFact,
  FACT_MAX_CHARS,
  FACTS_PER_USER_MAX,
  factLabel,
  listFacts,
  parseFactId,
} from './store.js';

async function logEvent(ctx: ToolContext, type: string, payload: object) {
  await appendEvent(ctx.threadId, type, ctx.speakerId, payload).catch((err) => log.warn({ err, type }, 'appendEvent failed'));
}

export function rememberTool(ctx: ToolContext) {
  return tool({
    description:
      "Save a fact to the current speaker's private memory, right away. Use when the speaker asks you to remember something, " +
      'or states a lasting preference about how you should help them. Write it short, in third person ("prefers short answers", ' +
      '"is building a robot arm for Blueprint"). Facts about other people must be attributed to the speaker, e.g. ' +
      '"Ingo says Sam is handling venues". Never save health, family situations or other sensitive details about other people.',
    inputSchema: z.object({ fact: z.string().min(1).max(FACT_MAX_CHARS) }),
    execute: async ({ fact }) => {
      const text = cleanFactText(fact);
      if (!text) return 'Nothing to remember.';
      if ((await countFacts(ctx.speakerId)) >= FACTS_PER_USER_MAX)
        return `Memory is full (${FACTS_PER_USER_MAX} facts). Ask the speaker to forget something first (App Home lists everything).`;
      const existing = await listFacts(ctx.speakerId);
      const dup = existing.find((f) => f.text.toLowerCase() === text.toLowerCase());
      if (dup) return `Already remembered as ${factLabel(dup.id)}.`;
      const row = await addFact(ctx.speakerId, text, ctx.threadId);
      await logEvent(ctx, 'memory_add', { factId: row.id });
      return `Saved as ${factLabel(row.id)}.`;
    },
  });
}

export function forgetTool(ctx: ToolContext) {
  return tool({
    description:
      "Delete one fact from the current speaker's memory by its id (e.g. m_42, as shown in the memory section). " +
      'Only the speaker\'s own facts can be deleted. To forget everything, point them to the bot\'s App Home tab.',
    inputSchema: z.object({ fact_id: z.union([z.string(), z.number()]).describe('e.g. "m_42" or 42') }),
    execute: async ({ fact_id }) => {
      const id = parseFactId(fact_id);
      if (!id) return `"${fact_id}" isn't a fact id. Ids look like m_42.`;
      const ok = await deleteFact(ctx.speakerId, id);
      if (!ok) return `No fact ${factLabel(id)} in this speaker's memory.`;
      await logEvent(ctx, 'memory_forget', { factId: id });
      return `Forgot ${factLabel(id)}.`;
    },
  });
}

export function proposeWorkspaceFactTool(ctx: ToolContext) {
  return tool({
    description:
      'Propose a fact about this Slack workspace itself (what a channel is for, a recurring event, who runs something) for the ' +
      'shared knowledge base. It goes to the admin for approval and is only used once approved. Not for personal facts — use ' +
      'remember for those. Keep it short, neutral and self-contained.',
    inputSchema: z.object({ fact: z.string().min(1).max(WS_FACT_MAX_CHARS) }),
    execute: async ({ fact }) => {
      const text = cleanFactText(fact);
      if (!text) return 'Nothing to propose.';
      const res = await proposeWorkspaceFact(ctx.speakerId, text, ctx.threadId);
      await logEvent(ctx, 'workspace_fact_proposed', { text });
      return res;
    },
  });
}

export function registerMemoryTools() {
  registerTool({ name: 'remember', roles: ['front'], build: rememberTool });
  registerTool({ name: 'forget', roles: ['front'], build: forgetTool });
  registerTool({ name: 'propose_workspace_fact', roles: ['front'], build: proposeWorkspaceFactTool });
}
