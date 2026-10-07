/**
 * `spawn_coding_agent` (front agent only, and only offered in the admin's own 'user' turns: front.ts drops it otherwise;
 * the checks are repeated in proposeCodingAgent). It only proposes: the admin launches with a button (confirm.ts).
 * Steering and cancelling go through message_subagent / cancel_subagent.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../../core/tools.js';
import { turnState } from '../turn-state.js';
import { limits } from '../../config.js';
import { proposeCodingAgent } from './confirm.js';
import { CODING_INSTRUCTIONS_MAX } from './confirm-logic.js';

registerTool({
  name: 'spawn_coding_agent',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        "Admin only. Propose a Cursor cloud coding agent that works on THIS bot's own code (its GitHub repo) — edits or codebase search/exploration; a pull request opens when there are changes. Only for changes to or questions about the bot's own code and behaviour: never for deliverables for people (websites, pages, apps, scripts, documents, research), even when the admin asks; make those with create_file / reply(files), canvases or subagents. It takes 10-60 minutes. The admin first sees the exact title and task in a private preview and must press Launch: nothing starts before that. It cannot see this conversation: give complete, self-contained instructions (what to change or find and why, relevant behaviour, error messages, files if known, how to verify for edits), based only on what the admin asked. Fixed rules (CLAUDE.md, never touching CI or repo-policy config, PR only; tests and self-review when the agent judges them necessary) are added automatically. Once launched it shows on a plan card; you get a summary (and a PR link if present) in a later turn. Steer or follow up with message_subagent (only with the admin's own words), stop with cancel_subagent.",
      inputSchema: z.object({
        title: z.string().describe('Short task title for the plan card, e.g. "Fix reminder time zones" (≤ 6 words)'),
        instructions: z.string().describe(`Complete, self-contained task for the coding agent (max ${CODING_INSTRUCTIONS_MAX} chars)`),
      }),
      execute: async ({ title, instructions }) => {
        const s = turnState(ctx);
        const r = await proposeCodingAgent({
          threadId: s.threadId,
          channelId: s.channelId,
          threadTs: s.threadTs,
          turnId: s.turn.id,
          turnKind: s.turn.kind,
          ownerId: s.turn.authorId,
          title,
          instructions,
        });
        return {
          pending_id: r.pendingId,
          status: 'awaiting_admin_confirmation',
          note: `${r.reused ? 'The admin already has this preview. ' : ''}Nothing has started: the admin sees a private preview with Launch / Cancel (expires in ${Math.round(limits.cursorConfirmTtlMs / 60_000)} min). Reply once, very short (e.g. "check the preview and hit Launch"); that ends your turn. Once launched it shows on a plan card and you get the PR link and summary in a later turn; if they cancel, the launch fails or the preview expires, you get a turn saying so. Never say it started, is running or is merged.`,
        };
      },
    }),
});
