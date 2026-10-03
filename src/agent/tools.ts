/**
 * Agent-module tools (front agent only): reply, spawn_subagent, message_subagent, cancel_subagent, set_card_title.
 * Registered at import time; src/agent/register.ts imports this file.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { registerTool } from '../core/tools.js';
import { cancelSubagent, messageSubagent, spawnSubagent } from './subagents.js';
import { MAX_BUTTONS, MAX_LABEL_CHARS } from './reply-buttons.js';
import { turnState } from './turn-state.js';

const fileSchema = z.object({
  filename: z.string().describe('File name with extension, e.g. "report.md" or "data.csv"'),
  content: z.string().describe('Full text content of the file'),
});

/**
 * Deliberately lenient (no min/max): a schema violation would fail the call after its text already streamed, and a
 * retry would show the reply twice. Limits are enforced in code (normalizeButtonLabels: ≤ MAX_BUTTONS labels,
 * clipped to MAX_LABEL_CHARS) and stated in the description.
 */
export const buttonsSchema = z
  .array(z.string())
  .optional()
  .describe(
    `Optional quick-reply buttons under the message, only when you ask the speaker a question with a few clear options. 1-${MAX_BUTTONS} short plain-text labels (≤ ${MAX_LABEL_CHARS} chars each), each exactly what the user would reply; a press posts that label as their message. Omit for normal answers.`,
  );

registerTool({
  name: 'end_turn',
  roles: ['front'],
  build: () =>
    tool({
      description:
        "End your turn. Call it when you've done everything you want to do this turn (you can call it in the same step as your last reply or reaction). Nothing is shown to anyone.",
      inputSchema: z.object({}),
      execute: async () => 'Turn ended.',
    }),
});

registerTool({
  name: 'reply',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        'Post a message in the current Slack thread (markdown). The only way to talk to people in this thread. Not calling it is a valid choice (silence, or a reaction instead). Usually one reply per turn; never send two replies that say the same thing.',
      inputSchema: z.object({
        text: z.string().describe('Message text in Slack-flavoured markdown. Keep it concise.'),
        files: z.array(fileSchema).max(5).optional().describe('Optional text files to attach below the message'),
        buttons: buttonsSchema,
      }),
      onInputStart: ({ toolCallId }) => {
        turnState(ctx).replies.start(toolCallId);
      },
      onInputDelta: ({ toolCallId, inputTextDelta }) => {
        turnState(ctx).replies.delta(toolCallId, inputTextDelta);
      },
      execute: async ({ text, files, buttons }, { toolCallId }) => {
        const s = turnState(ctx);
        const res = await s.replies.finish(toolCallId, text, files, buttons);
        if (res.startsWith('Replied')) {
          s.visible.add('reply');
          return `${res} Don't send another reply unless you have something new; call end_turn when you're done.`;
        } else if (s.replies.anyVisible) s.visible.add('reply'); // e.g. a stream the user stopped halfway
        return res;
      },
    }),
});

registerTool({
  name: 'spawn_subagent',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        'Start a background subagent for work longer than one or two quick lookups (research, comparing sources, reading many pages/channels, summarising long threads). It cannot see this conversation: give complete, self-contained instructions. Progress shows on a plan card; when all subagents of this turn finish you get their results to write the answer.',
      inputSchema: z.object({
        title: z.string().describe('Short task title for the plan card, e.g. "Research hosting options" (≤ 6 words)'),
        instructions: z.string().describe('Complete instructions: the task, all needed context (links, names, image ids img_N), and what a good result looks like'),
        strong: z.boolean().optional().describe('Use a stronger, slower model for genuinely hard reasoning tasks'),
        seed_from: z.string().optional().describe('Id of an expired subagent whose summary should seed this one'),
      }),
      execute: async ({ title, instructions, strong, seed_from }) => {
        const s = turnState(ctx);
        const r = await spawnSubagent({
          threadId: s.threadId,
          turnId: s.turn.id,
          ownerId: s.turn.authorId,
          title,
          instructions,
          strong,
          seedFrom: seed_from,
        });
        s.cardId = r.cardId;
        s.spawned.add(r.subagentId);
        s.delegated = true;
        s.visible.add('spawn');
        return {
          subagent_id: r.subagentId,
          status: 'queued',
          note: 'Plan card will be posted below your reply. Do not research this yourself or answer it now; at most one short acknowledgement (if you have not replied yet), then call end_turn. You get the results in a later turn.',
        };
      },
    }),
});

registerTool({
  name: 'message_subagent',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        "Send a message to an existing subagent from the snapshot. If it is running, the message steers it (seen at its next step; shown on its card row as a note). If it is idle, this starts a follow-up run with its full prior history. Don't steer another user's subagent without the owner's confirmation.",
      inputSchema: z.object({
        id: z.string().describe('Subagent id, e.g. "sa_ab12cd"'),
        text: z.string().describe('The instruction / follow-up for the subagent, self-contained'),
        note: z.string().optional().describe('Very short card note for a steer, e.g. "also checking #ship" (≤ 6 words)'),
      }),
      execute: async ({ id, text, note }) => {
        const s = turnState(ctx);
        const r = await messageSubagent({ threadId: s.threadId, turnId: s.turn.id, speakerId: s.turn.authorId, subagentId: id, text, note });
        if (r.mode === 'resumed') {
          s.cardId = r.cardId;
          s.delegated = true;
          s.visible.add('resume');
          return { status: 'resumed', note: 'A follow-up run started; it appears on this turn\'s plan card.' };
        }
        s.visible.add('steer');
        return { status: 'steered', note: 'Delivered; it will see this at its next step. Acknowledge the user visibly with either a reaction or a very short reply (not both).' };
      },
    }),
});

registerTool({
  name: 'cancel_subagent',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        "Cancel a subagent (it stops at its next step and can't be resumed). Use when its owner asks to stop. Don't cancel another user's subagent without the owner's confirmation.",
      inputSchema: z.object({ id: z.string().describe('Subagent id, e.g. "sa_ab12cd"') }),
      execute: async ({ id }) => {
        const s = turnState(ctx);
        const msg = await cancelSubagent({ threadId: s.threadId, subagentId: id, actor: s.turn.authorId });
        s.visible.add('cancel');
        if (s.spawned.delete(id)) {
          // Cancelling a subagent this very turn started: its card stays unposted and its synthesis stays silent
          // (a run that still finishes is recorded as cancelled), so nobody would get an answer from it.
          s.delegated = s.spawned.size > 0 || s.visible.has('resume');
          return `${msg} You started it in this turn, so no results will come from it: answer the speaker yourself now, or spawn again.`;
        }
        return msg;
      },
    }),
});

registerTool({
  name: 'set_card_title',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description: `Only when writing up finished subagent results: set the final title of their plan card, past tense, ≤ ${limits.cardTitleMaxChars} characters (e.g. "Compared 3 hosting options"). Call before your reply.`,
      inputSchema: z.object({ title: z.string() }),
      execute: async ({ title }) => {
        const s = turnState(ctx);
        if (s.turn.kind !== 'synthesis' || !s.turn.cardId) {
          throw new Error('set_card_title is only available when reporting finished subagent results.');
        }
        const t = title.trim().replace(/\s+/g, ' ');
        await sql`update cards set title = ${t} where id = ${s.turn.cardId}`;
        s.visible.add('card');
        if (t.length > limits.cardTitleMaxChars) {
          return `Title is over ${limits.cardTitleMaxChars} characters, so the card will show a generic title. Call again with a shorter one if you like.`;
        }
        return 'Card title set.';
      },
    }),
});
