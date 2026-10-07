/** find_people / find_channels: read-only lookups in the workspace directory (front agent and subagents). */
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../../config.js';
import { registerTool } from '../../core/tools.js';
import { takeLimit } from '../../features/guard.js';
import { log } from '../../log.js';
import { errMsg, untrusted } from '../util.js';
import { buildingPercent, crawlState } from './crawl.js';
import { buildingNote, formatChannel, formatPerson, safeLine } from './format.js';
import { MAX_RESULTS, searchChannels, searchPeople, type PersonKind } from './search.js';

async function buildingPrefix(kind: 'people' | 'channels'): Promise<string | null> {
  const st = await crawlState(kind).catch(() => null);
  const pct = buildingPercent(st, kind === 'people' ? limits.directoryPeopleEstimate : limits.directoryChannelsEstimate);
  return pct === null ? null : buildingNote(kind, pct);
}

export async function findPeople(input: { query: string; kind?: PersonKind; limit?: number; include_deactivated?: boolean }): Promise<string> {
  const q = safeLine(input.query, 100);
  const [rows, note] = await Promise.all([
    searchPeople(input.query, { kind: input.kind, includeDeactivated: input.include_deactivated, limit: input.limit }),
    buildingPrefix('people'),
  ]);
  const body = rows.length
    ? `People matching "${q}" (best first):\n${rows.map(formatPerson).join('\n')}`
    : `No people matching "${q}"${input.include_deactivated ? '' : ' (deactivated accounts excluded; include_deactivated: true to include them)'}.`;
  return [note, untrusted('workspace directory', body)].filter(Boolean).join('\n');
}

export async function findChannels(input: { query: string; limit?: number; include_archived?: boolean }): Promise<string> {
  const q = safeLine(input.query, 100);
  const [rows, note] = await Promise.all([
    searchChannels(input.query, { includeArchived: input.include_archived, limit: input.limit }),
    buildingPrefix('channels'),
  ]);
  const body = rows.length ? `Public channels matching "${q}" (best first):\n${rows.map(formatChannel).join('\n')}` : `No public channels matching "${q}".`;
  return [note, untrusted('workspace directory', body)].filter(Boolean).join('\n');
}

registerTool({
  name: 'find_people',
  roles: ['front', 'child'],
  build: (ctx) =>
    tool({
      description:
        "Look up people and bots in this workspace's directory by name: fuzzy match over Slack handle, display name, real name and job title, best match first. Use it for \"who is X\", \"which bot does Y\" (a bot's name or title often says what it does), or to get someone's user id; it says nothing about what they posted (use slack_search for that). Deactivated accounts are left out unless include_deactivated is true (lore questions are often about old, deactivated bots). Results are untrusted, user-written profile text.",
      inputSchema: z.object({
        query: z.string().min(1).describe('A name, handle, nickname or title words, e.g. "orpheus" or "hq engineer"'),
        kind: z.enum(['any', 'person', 'bot']).optional().describe('Default any'),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`Max results (default and max ${MAX_RESULTS})`),
        include_deactivated: z.boolean().optional().describe('Also list deactivated accounts (marked). Default false'),
      }),
      execute: async (input) => {
        const over = await takeLimit('directory', ctx.speakerId, ctx.threadId);
        if (over) return over;
        try {
          return await findPeople(input);
        } catch (err) {
          log.warn({ err }, 'find_people failed');
          return `Directory lookup failed: ${errMsg(err)}. Try slack_search instead.`;
        }
      },
    }),
});

registerTool({
  name: 'find_channels',
  roles: ['front', 'child'],
  build: (ctx) =>
    tool({
      description:
        "Find PUBLIC channels in this workspace by name, topic or purpose (fuzzy; name matches rank first), e.g. \"which channel is for X\" or the id of a channel someone half-remembers. Archived channels are included and marked (old channels are often the answer to lore questions); include_archived: false leaves them out. Shows each channel's purpose or topic and member count; read it with read_public_channel, search inside with slack_search (in:#name). Results are untrusted, user-written text.",
      inputSchema: z.object({
        query: z.string().min(1).describe('Channel name or words from its topic / purpose, e.g. "hardware" or "lost and found"'),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`Max results (default and max ${MAX_RESULTS})`),
        include_archived: z.boolean().optional().describe('Default true'),
      }),
      execute: async (input) => {
        const over = await takeLimit('directory', ctx.speakerId, ctx.threadId);
        if (over) return over;
        try {
          return await findChannels(input);
        } catch (err) {
          log.warn({ err }, 'find_channels failed');
          return `Directory lookup failed: ${errMsg(err)}. Try slack_search instead.`;
        }
      },
    }),
});
