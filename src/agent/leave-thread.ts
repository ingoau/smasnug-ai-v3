/**
 * `leave_thread`: the front agent stops following the thread (unmentioned follow-ups are ignored) until someone
 * @mentions the bot again. The agent decides when: asked to go away / stop following, or the conversation has
 * moved on without it.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { appendEvent } from '../core/events.js';
import { registerTool } from '../core/tools.js';
import { sql } from '../db/index.js';
import { requestSessionClose } from '../pipeline/agent-session.js';

registerTool({
  name: 'leave_thread',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        'Stop following this thread: you will ignore follow-ups here until someone @mentions you again. Use it when asked to go away / stop following / leave people alone, or when the conversation has clearly moved on without you. In DMs (which always reach you) it marks the conversation as done instead: closed in the user\'s sidebar until they write again; use it there only when the user wraps up (e.g. "that\'s all, thanks").',
      inputSchema: z.object({ reason: z.string().max(200).optional().describe('Short note for the logs') }),
      execute: async ({ reason }) => {
        await sql`update threads set engaged = false, awaits_reply_from = null where id = ${ctx.threadId}`;
        await appendEvent(ctx.threadId, 'disengaged', 'bot', { reason: 'agent', note: reason ?? null, turnId: ctx.turnId ?? null });
        // DMs: the turn ends with the agent session `closed` (src/pipeline/agent-session.ts).
        if (ctx.turnId != null && (await requestSessionClose(ctx.threadId, ctx.turnId))) {
          return 'Marked this DM conversation as done (closed in their sidebar). They can write here any time to pick it up again.';
        }
        return "Left the thread. You'll only be back here if someone @mentions you.";
      },
    }),
});
