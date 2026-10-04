/**
 * `spawn_coding_agent` (front agent only, and only offered in the admin's turns: front.ts drops it otherwise; the
 * admin check is repeated in spawnCodingAgent). Steering and cancelling go through message_subagent / cancel_subagent.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../../core/tools.js';
import { turnState } from '../turn-state.js';
import { spawnCodingAgent } from './agents.js';

registerTool({
  name: 'spawn_coding_agent',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        "Admin only. Start a Cursor cloud coding agent that changes THIS bot's own code (its GitHub repo) and opens a pull request; it takes 10-60 minutes. It cannot see this conversation: give complete, self-contained instructions (what to change and why, relevant behaviour, error messages, files if known, how to verify). Fixed rules (CLAUDE.md, never touching CI workflows, tests, self-review, PR only) are added automatically. Shows on the plan card; you get the PR link and summary in a later turn. Steer or follow up with message_subagent, stop with cancel_subagent.",
      inputSchema: z.object({
        title: z.string().describe('Short task title for the plan card, e.g. "Fix reminder time zones" (≤ 6 words)'),
        instructions: z.string().describe('Complete, self-contained task for the coding agent'),
      }),
      execute: async ({ title, instructions }) => {
        const s = turnState(ctx);
        const r = await spawnCodingAgent({ threadId: s.threadId, turnId: s.turn.id, ownerId: s.turn.authorId, title, instructions });
        s.cardId = r.cardId;
        s.spawned.add(r.subagentId);
        s.delegated = true;
        s.visible.add('spawn');
        return {
          subagent_id: r.subagentId,
          status: 'started',
          note: "The coding agent is working in Cursor (usually 10-60 min); the plan card shows it. Reply once with a short acknowledgement (if you haven't), then call end_turn. You get the PR link and summary in a later turn; never say it's merged.",
        };
      },
    }),
});
