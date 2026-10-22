/**
 * Memory tools for the front agent. None of them take a user id: the user is always ctx.speakerId.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool, type ToolContext } from '../../core/tools.js';
import { appendEvent } from '../../core/events.js';
import { log } from '../../log.js';
import { proposeWorkspaceFact, WS_FACT_MAX_CHARS } from '../workspace.js';
import { formatFactLine } from './render.js';
import {
  addFact,
  cleanFactText,
  contentWords,
  deleteFact,
  FACT_KINDS,
  FACT_MAX_CHARS,
  FACTS_PER_USER_MAX,
  factLabel,
  findDuplicate,
  listFacts,
  orTsQuery,
  parseFactId,
  rankFacts,
  touchFacts,
  updateFact,
} from './store.js';

const SEARCH_RESULTS_MAX = 10;

async function logEvent(ctx: ToolContext, type: string, payload: object) {
  await appendEvent(ctx.threadId, type, ctx.speakerId, payload).catch((err) => log.warn({ err, type }, 'appendEvent failed'));
}

export function rememberTool(ctx: ToolContext) {
  return tool({
    description:
      "Save a fact to the current speaker's private memory, right away. Call it whenever the speaker mentions something lasting " +
      'about themselves (a project, their stack or tools, skills, role, interests, time zone, how they like answers) or asks you ' +
      'to remember something, in the same step as your reply and without announcing it. Write it short, in third person ("prefers short answers", ' +
      '"is building a robot arm for Blueprint"). When it changes a fact you already have (shown with its id), pass that id as ' +
      'replaces instead of adding a second one. Facts about other people must be attributed to the speaker, e.g. ' +
      '"Ingo says Sam is handling venues". Never save health, family situations or other sensitive details about other people.',
    inputSchema: z.object({
      fact: z.string().min(1).max(FACT_MAX_CHARS),
      kind: z
        .enum(FACT_KINDS)
        .describe('preference: how they want you to help (style, language, tools); about: who they are (role, skills, interests, time zone); project: what they are working on now'),
      replaces: z.union([z.string(), z.number()]).optional().describe('id of the existing fact this one updates (e.g. "m_42"), if any'),
    }),
    execute: async ({ fact, kind, replaces }) => {
      const text = cleanFactText(fact);
      if (!text) return 'Nothing to remember.';
      if (replaces != null && replaces !== '') {
        const id = parseFactId(replaces);
        if (!id || !(await updateFact(ctx.speakerId, id, text, ctx.threadId, kind))) return `No fact ${replaces} in this speaker's memory to replace.`;
        await logEvent(ctx, 'memory_update', { factId: id });
        return `Updated ${factLabel(id)}.`;
      }
      const existing = await listFacts(ctx.speakerId);
      const dup = findDuplicate(text, existing);
      if (dup) return `Already remembered as ${factLabel(dup.id)}: "${dup.text}". If it changed, call remember again with replaces: "${factLabel(dup.id)}".`;
      if (existing.length >= FACTS_PER_USER_MAX)
        return `Memory is full (${FACTS_PER_USER_MAX} facts). Ask the speaker to forget something first (App Home lists everything).`;
      const row = await addFact(ctx.speakerId, text, ctx.threadId, kind);
      await logEvent(ctx, 'memory_add', { factId: row.id });
      return `Saved as ${factLabel(row.id)}.`;
    },
  });
}

export function searchMemoryTool(ctx: ToolContext) {
  return tool({
    description:
      "Search the current speaker's private memory for facts not shown in <speaker_memory> (only the most relevant ones are). " +
      "Use it when something about them might be saved that isn't shown, e.g. a project or tool they mentioned before.",
    inputSchema: z.object({ query: z.string().min(1).max(200).describe('words to look for, e.g. "robot arm" or "rust"') }),
    execute: async ({ query }) => {
      const facts = await rankFacts(ctx.speakerId, orTsQuery([query]));
      const words = contentWords(query);
      // Full-text first, then a plain substring match (names, ids and words the english stemmer mangles).
      const hits = facts
        .map((f) => ({ f, score: f.rank > 0 ? 1 + f.rank : words.some((w) => f.text.toLowerCase().includes(w)) ? 0.5 : 0 }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, SEARCH_RESULTS_MAX)
        .map((h) => h.f);
      if (hits.length === 0) return facts.length ? 'No saved fact matches.' : 'Nothing is saved about this speaker.';
      await touchFacts(
        ctx.speakerId,
        hits.map((f) => f.id),
      ).catch((err) => log.warn({ err }, 'touch memory failed'));
      return hits.map((f) => `${formatFactLine(f)} [${f.kind}]`).join('\n');
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
  registerTool({ name: 'search_memory', roles: ['front'], build: searchMemoryTool });
  registerTool({ name: 'propose_workspace_fact', roles: ['front'], build: proposeWorkspaceFactTool });
}
