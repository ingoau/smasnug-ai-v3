/**
 * Memory tools for the front agent. None of them take a user id: the user is always ctx.speakerId.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool, type ToolContext } from '../../core/tools.js';
import { appendEvent } from '../../core/events.js';
import { log } from '../../log.js';
import { channelCreator } from '../killswitch.js';
import { isAdmin } from '../util.js';
import { proposeWorkspaceFact, WS_FACT_MAX_CHARS } from '../workspace.js';
import { formatFactLine } from './render.js';
import {
  addFact,
  cleanFactText,
  deleteFact,
  FACT_KINDS,
  FACT_MAX_CHARS,
  FACTS_PER_USER_MAX,
  factLabel,
  findDuplicate,
  isSensitive,
  listFacts,
  NEVER_STORE,
  orTsQuery,
  parseFactId,
  rankFacts,
  sameFact,
  sameThing,
  similarityWords,
  touchFacts,
  updateFact,
} from './store.js';

const SEARCH_RESULTS_MAX = 10;
/** Too common in facts to match on alone in search_memory's word fallback. */
const GENERIC_SEARCH_WORDS = new Set(['not', 'use', 'prefer', 'like', 'work', 'working', 'build', 'building', 'learn', 'learning', 'know']);

async function logEvent(ctx: ToolContext, type: string, payload: object) {
  await appendEvent(ctx.threadId, type, ctx.speakerId, payload).catch((err) => log.warn({ err, type }, 'appendEvent failed'));
}

export function rememberTool(ctx: ToolContext) {
  return tool({
    description:
      "Save a fact to the current speaker's private memory, right away. Call it whenever the speaker mentions something lasting " +
      'about themselves (a project, their stack or tools, skills, role, interests, time zone, how they like answers or want you ' +
      'to respond to them, e.g. "only react to my reminder requests", "don\'t ping me") or asks you ' +
      'to remember something, in the same step as your reply and without announcing it. Write it short, in third person ("prefers short answers", ' +
      '"is building a robot arm for Blueprint"). When it changes a fact you already have (shown with its id), pass that id as ' +
      'replaces; a near-duplicate of a saved fact updates that fact instead of adding a second one. Facts about other people must be ' +
      `attributed to the speaker, e.g. "Ingo says Sam is handling venues". Never save ${NEVER_STORE}, about anyone.`,
    inputSchema: z.object({
      fact: z.string().min(1).max(FACT_MAX_CHARS),
      kind: z
        .enum(FACT_KINDS)
        .describe('preference: how they want you to help or treat them (style, language, tools, "just react to my reminders", "don\'t ping me"); about: who they are (role, skills, interests, time zone); project: what they are working on now'),
      replaces: z.union([z.string(), z.number()]).optional().describe('id of the existing fact this one updates (e.g. "m_42"), if any'),
      no_ping: z
        .boolean()
        .optional()
        .describe(
          'true only when this preference is that they don\'t want to be @mentioned/pinged/tagged by you (then you write their plain name instead, also in other people\'s conversations). Not for anything else that mentions pinging, tags or mentions.',
        ),
    }),
    // Usually called alongside the reply, which ends the turn, so the model rarely sees this result: every outcome
    // here must be right without a follow-up call.
    execute: async ({ fact, kind, replaces, no_ping }) => {
      const text = cleanFactText(fact);
      if (!text) return 'Nothing to remember.';
      if (isSensitive(text)) return `Not saved: memory never keeps ${NEVER_STORE}.`;
      const noPing = kind === 'preference' && no_ping === true;
      const existing = await listFacts(ctx.speakerId);
      const replacedId = replaces != null && replaces !== '' ? parseFactId(replaces) : null;
      let target = existing.find((f) => f.id === replacedId);
      if (!target) {
        const dup = findDuplicate(text, existing, { strict: true });
        if (dup && sameFact(dup.text, text) && dup.kind === kind && dup.noPing === noPing) return `Already remembered as ${factLabel(dup.id)}.`;
        target = dup;
      }
      if (target) {
        // One fact per thing: other facts the new text duplicates go.
        const merged = existing.filter((f) => f.id !== target.id && sameThing(text, f.text));
        for (const f of merged) await deleteFact(ctx.speakerId, f.id);
        await updateFact(ctx.speakerId, target.id, text, ctx.threadId, kind, noPing);
        await logEvent(ctx, 'memory_update', { factId: target.id, merged: merged.map((f) => f.id) });
        return `Updated ${factLabel(target.id)} (was: "${target.text}")${merged.length ? `, merged ${merged.map((f) => factLabel(f.id)).join(', ')}` : ''}.`;
      }
      if (existing.length >= FACTS_PER_USER_MAX)
        return `Memory is full (${FACTS_PER_USER_MAX} facts). Ask the speaker to forget something first (App Home lists everything).`;
      const row = await addFact(ctx.speakerId, text, ctx.threadId, kind, noPing);
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
      // Full-text first, then whole words of any length ("go", "js", names the english stemmer mangles).
      const terms = new Set(similarityWords(query).filter((w) => !GENERIC_SEARCH_WORDS.has(w)));
      const hits = facts
        .map((f) => ({ f, score: f.rank > 0 ? 1 + f.rank : similarityWords(f.text).some((w) => terms.has(w)) ? 0.5 : 0 }))
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

/**
 * Who may set a rule right away: the admin (any scope), or the channel's creator ('owner') for a rule about their
 * channel. Anyone can create a public channel, so an owner's rule is rendered as their preference, not a workspace rule,
 * and still reported to the moderation channel (workspace.ts). Everyone else's proposals wait for the admin (null).
 */
export async function ruleSetter(speakerId: string, scope: 'workspace' | 'channel', channelId: string): Promise<'admin' | 'owner' | null> {
  if (isAdmin(speakerId)) return 'admin';
  if (scope !== 'channel') return null;
  const { creator } = await channelCreator(channelId);
  return !!creator && creator === speakerId ? 'owner' : null;
}

export function proposeWorkspaceFactTool(ctx: ToolContext) {
  return tool({
    description:
      'Save a fact about this Slack workspace (what a channel is for, a recurring event, who runs something) or a RULE for how ' +
      'you behave, for everyone: workspace-wide or only in this channel (scope). Use it when the admin or the channel\'s owner ' +
      'states how you should act ("reminder requests here just get a ✅, no reply", "don\'t answer questions in this channel"). ' +
      "The admin's (and the channel creator's, for their channel, as the owner's preference) apply from the next turn; anyone else's go to the admin for " +
      "approval. Not for one person's own preferences (\"don't ping me\", \"just react to my requests\"): remember those (kind " +
      'preference). Keep it short, neutral and self-contained.',
    inputSchema: z.object({
      fact: z.string().min(1).max(WS_FACT_MAX_CHARS),
      scope: z.enum(['workspace', 'channel']).default('workspace').describe('channel: applies only in the current channel'),
    }),
    execute: async ({ fact, scope = 'workspace' }) => {
      const text = cleanFactText(fact);
      if (!text) return 'Nothing to propose.';
      if (scope === 'channel' && /^[DG]/.test(ctx.channelId))
        return "Channel rules are for channels; in a DM, remember the speaker's own preference instead.";
      const setter = await ruleSetter(ctx.speakerId, scope, ctx.channelId).catch(() => null);
      const autoApprove = setter != null;
      const res = await proposeWorkspaceFact(ctx.speakerId, text, ctx.threadId, {
        channelId: scope === 'channel' ? ctx.channelId : null,
        autoApprove,
        setByOwner: setter === 'owner',
      });
      await logEvent(ctx, 'workspace_fact_proposed', { text, scope, autoApprove, ...(setter === 'owner' ? { setByOwner: true } : {}) });
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
