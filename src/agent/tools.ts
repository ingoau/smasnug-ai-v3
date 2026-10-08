/**
 * Agent-module tools (front agent only): reply, spawn_subagent, message_subagent, cancel_subagent (card titles: src/agent/titles.ts, in the background).
 * Registered at import time; src/agent/register.ts imports this file.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { registerTool } from '../core/tools.js';
import { cancelSubagent, messageSubagent, spawnSubagent, ToolError } from './subagents.js';
import { MAX_BUTTONS, MAX_LABEL_CHARS } from './reply-buttons.js';
import { turnState } from './turn-state.js';
import { continueTurnSchema } from './turn-end.js';
import { prepareOutgoingFiles } from './files.js';
import { accessModelText, canUseSandbox, notifyAccess } from '../sandbox/access.js';
import { sandboxConfigured } from '../sandbox/settings.js';

/**
 * `reply(files)`: file ids (uploads, subagent results, create_file), or an inline text file that is stored first.
 * Lenient like the rest of the reply schema: unknown ids are reported in the result, never a schema error.
 */
export const replyFilesSchema = z
  .array(
    z.union([
      z.string().describe('A file id, e.g. "file_k3x9q2mf7a"'),
      z.object({
        filename: z.string().describe('File name with extension, e.g. "report.md" or "index.html"'),
        content: z.string().describe('Full text content of the file'),
        description: z.string().optional().describe('One line saying what the file is'),
      }),
    ]),
  )
  .optional()
  .describe(
    'Optional files to post below the message: file ids (file_…) from this conversation, subagent results, create_file, or the speaker\'s own files from elsewhere ("post the page you made me yesterday"); post subagent-made files without reading them. Or an inline text file {filename, content}. HTML files are fine (Slack shows them).',
  );

/**
 * Deliberately lenient (no min/max): a schema violation would fail the call after its text already streamed, and a
 * retry would show the reply twice. Labels are shown as written; code only applies Slack's hard limits and the
 * documented MAX_BUTTONS (normalizeButtonLabels).
 */
export const buttonsSchema = z
  .array(z.string())
  .optional()
  .describe(
    `Optional quick-reply buttons under the message. Use them whenever the message asks a question with a few clear answers (options like "price, size or wireless?", a "which one?", a yes/no). And when there's a logical next step the user would likely want (dig deeper, draft or write it, run it, set a reminder, send it), end with one short offer plus buttons, e.g. "want me to draft it?" → ["Yes, draft it", "No thanks"]. At most one offer per message, only when genuinely useful: never on bare greetings or thanks, or while the user is mid-task giving you instructions. 1-${MAX_BUTTONS} short plain-text labels (≤ ${MAX_LABEL_CHARS} chars), each exactly what the user would type back; a press posts that label as their message. Omit for open questions and when there's no clear next step.`,
  );

registerTool({
  name: 'end_turn',
  roles: ['front'],
  build: () =>
    tool({
      description:
        'End your turn without posting anything (a silent turn). Not needed after reply / react: those end the turn by themselves unless you pass continue_turn. Nothing is shown to anyone.',
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
        'Post a message in the current Slack thread (markdown). The only way to talk to people in this thread. Not calling it is a valid choice (silence, or a reaction instead). A reply ends your turn unless continue_turn is true (calls in the same step that need their results, like searches, still run and come back to you). Usually one reply per turn; never send two replies that say the same thing.',
      inputSchema: z.object({
        text: z.string().describe('Message text in Slack-flavoured markdown. Keep it concise.'),
        files: replyFilesSchema,
        buttons: buttonsSchema,
        continue_turn: continueTurnSchema,
      }),
      onInputStart: ({ toolCallId }) => {
        turnState(ctx).replies.start(toolCallId);
      },
      onInputDelta: ({ toolCallId, inputTextDelta }) => {
        turnState(ctx).replies.delta(toolCallId, inputTextDelta);
      },
      execute: async ({ text, files, buttons }, { toolCallId }) => {
        const s = turnState(ctx);
        // At most 10 files per message (Slack); access is checked per id (this thread, or the speaker's own files).
        const prepared = await prepareOutgoingFiles({ threadId: ctx.threadId, speakerId: ctx.speakerId, turnId: ctx.turnId }, files?.slice(0, 10));
        const res = await s.replies.finish(toolCallId, text, prepared.files, buttons);
        const notes = [...prepared.errors, ...((files?.length ?? 0) > 10 ? ['Only the first 10 files were posted (Slack allows 10 per message).'] : [])];
        const fileNote = notes.length ? ` File problems: ${notes.join(' ')}` : '';
        if (res.startsWith('Replied')) {
          s.visible.add('reply');
          return `${res}${fileNote} Don't send another reply unless you have something new.`;
        } else if (s.replies.anyVisible) s.visible.add('reply'); // e.g. a stream the user stopped halfway
        return `${res}${fileNote}`;
      },
    }),
});

/** Subagents one spawn_subagent call may start (each is its own subagent; per-user / per-thread limits still apply). */
export const MAX_SPAWN_TASKS = 6;

registerTool({
  name: 'spawn_subagent',
  roles: ['front'],
  build: (ctx) =>
    tool({
      description:
        `Start background subagents for work longer than one or two quick lookups (research, comparing sources, reading many pages/channels). Each task in \`tasks\` becomes its own subagent and they all run in parallel: when the request names several items that each need research (products, libraries, frameworks, people, channels, options, cities, questions), pass one task per item in this ONE call (up to ${MAX_SPAWN_TASKS}), also for "A vs B vs C" or "compare A, B and C" (you compare when the results are back). One task for a single question, trivially small items, or a step whose finding the rest needs ("find the top 3 X" first; one task per item in the next round). A subagent cannot see this conversation: give each complete, self-contained instructions. Progress shows on a plan card; when all subagents of this turn finish you get their results to write the answer.`,
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              title: z.string().describe('Short task title for the plan card, e.g. "Research hosting options" (≤ 6 words)'),
              instructions: z.string().describe('Complete instructions: the task, all needed context (links, names, file ids file_… of uploads it should use), and what a good result looks like'),
              seed_from: z.string().optional().describe('Id of an expired subagent whose summary should seed this one'),
              ...(sandboxConfigured()
                ? { sandbox: z.boolean().optional().describe('Give this subagent a code sandbox (Linux, Python, Node, headless Chromium) to run code: installs, data processing, analysing files, a headless browser, multi-file builds, live previews. Not for a single file you can write yourself (use create_file).') }
                : {}),
            }),
          )
          .min(1)
          .max(MAX_SPAWN_TASKS)
          .describe('One entry per subagent: one per named item that needs its own research (each product, framework, person, channel…); a single entry when the items must be found first ("the top 3 X"; one entry per item in the next round). Never one entry that compares several named items'),
      }),
      execute: async ({ tasks }) => {
        const s = turnState(ctx);
        const started: { subagent_id: string; title: string }[] = [];
        const failed: { title: string; error: string }[] = [];
        let firstError: unknown;
        // One after another: the limits are checked per spawn, and every run is queued (and starts) right away.
        for (const t of tasks as (typeof tasks[number] & { sandbox?: boolean })[]) {
          try {
            if (t.sandbox) {
              // Access is checked before anything starts; the explanation goes to the owner only.
              const access = await canUseSandbox(s.turn.authorId);
              if (!access.ok) {
                void notifyAccess({ userId: s.turn.authorId, channelId: ctx.channelId, threadTs: ctx.threadTs, reason: access.reason });
                throw new ToolError(accessModelText(access.reason));
              }
            }
            const r = await spawnSubagent({
              threadId: s.threadId,
              turnId: s.turn.id,
              ownerId: s.turn.authorId,
              title: t.title,
              instructions: t.instructions,
              seedFrom: t.seed_from,
              sandbox: !!t.sandbox && sandboxConfigured(),
            });
            s.cardId = r.cardId;
            s.spawned.add(r.subagentId);
            s.delegated = true;
            s.visible.add('spawn');
            started.push({ subagent_id: r.subagentId, title: t.title });
          } catch (err) {
            firstError ??= err;
            failed.push({ title: t.title, error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (!started.length) throw tasks.length === 1 ? firstError : new ToolError(failed.map((f) => `"${f.title}": ${f.error}`).join('; '));
        return {
          started,
          status: 'queued',
          ...(failed.length ? { not_started: failed } : {}),
          note: 'Plan card will be posted below your reply. Do not research this yourself or answer it now; at most one short acknowledgement reply (if you have not replied yet; it ends your turn). You get the results in a later turn.',
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
        const r = await messageSubagent({ threadId: s.threadId, turnId: s.turn.id, turnKind: s.turn.kind, speakerId: s.turn.authorId, subagentId: id, text, note });
        if (r.mode === 'resumed') {
          s.cardId = r.cardId;
          s.delegated = true;
          s.visible.add('resume');
          return { status: 'resumed', note: 'A follow-up run started; it appears on this turn\'s plan card.' };
        }
        s.visible.add('steer');
        if (r.queued)
          return {
            status: 'queued',
            note: "Coding agents can't take messages mid-run: this is sent to Cursor as a follow-up as soon as its current run finishes (same branch and PR). Acknowledge briefly (a reaction or a very short reply saying it's queued).",
          };
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

