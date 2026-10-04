/**
 * `set_session_title` (front agent, DM threads only): a short title for the conversation in the user's sidebar
 * (Slack agent sessions). front.ts removes the tool outside DMs; the title logic (one per turn, never over a
 * user-chosen title) lives in src/pipeline/agent-session.ts.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../core/tools.js';
import { setSessionTitle, SESSION_TITLE_MAX } from '../pipeline/agent-session.js';

registerTool({
  name: 'set_session_title',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description: `DMs only: name this conversation in the user's sidebar. A short descriptive title, ≤ ${SESSION_TITLE_MAX} characters, sentence case, no quotes or emoji (e.g. "Pico W pinout question"). Call it alongside your reply on the first substantive turn; again only if the topic clearly changes. Never mention it.`,
      inputSchema: z.object({ title: z.string().describe(`≤ ${SESSION_TITLE_MAX} characters`) }),
      execute: async ({ title }) => {
        if (ctx.turnId == null) return 'Not renamed: no turn.';
        return setSessionTitle({ threadId: ctx.threadId, turnId: ctx.turnId, title });
      },
    }),
});
