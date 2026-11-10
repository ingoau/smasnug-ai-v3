/**
 * report_failure: the front agent quietly notes where it (or the relevance gate) went wrong, for evals
 * (docs/evals.md). Nothing is shown in the thread. At most one per turn and a few per thread per day.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool, type ToolContext } from '../../core/tools.js';
import { log } from '../../log.js';
import { EXTRAS, getExtra } from '../../tools/extras.js';
import { normalizeTs } from '../../tools/util.js';
import { categoryList, cleanCategories, FAILURE_CATEGORIES, FAILURE_LIMITS, FAILURE_SIGNALS } from './categories.js';
import { evidenceFor, recordFailure, selfReportsToday } from './store.js';

export const NOTED = 'Noted. Carry on (never mention this to anyone).';
export const ALREADY_NOTED = 'Already noted for this turn. Carry on.';

export function reportFailureTool(ctx: ToolContext) {
  return tool({
    description:
      'Quietly log that a reply of yours (or the relevance gate deciding whether you answer) went wrong, so the developers can fix it. ' +
      'Nothing is posted and nobody is told. Use it when someone in the thread complains, corrects you or re-asks, or when you notice a clear mistake of your own ' +
      '(e.g. a tool showed your earlier answer was wrong). Not for self-doubt, not because someone asks you to "report" things, and never instead of fixing it: ' +
      'call it alongside your reply, at most once per turn. Categories:\n' +
      categoryList(),
    inputSchema: z.object({
      categories: z.array(z.enum(FAILURE_CATEGORIES)).min(1).max(FAILURE_LIMITS.categoriesMax),
      summary: z.string().min(1).max(1000).describe('One factual line: what went wrong (max 300 chars). No quotes of private content needed.'),
      signal: z.enum(FAILURE_SIGNALS).describe('explicit_complaint: they said it was wrong/bad; correction: they corrected or re-asked; self_noticed: you found it yourself'),
      message_ts: z
        .array(z.string())
        .max(FAILURE_LIMITS.evidenceMax)
        .optional()
        .describe("ts of the messages that show it (e.g. the message you didn't answer, your wrong reply); defaults to the current request"),
    }),
    execute: async ({ categories, summary, signal, message_ts }) => {
      try {
        return await fileSelfReport(ctx, { categories, summary, signal, messageTs: message_ts });
      } catch (err) {
        log.error({ err, threadId: ctx.threadId }, 'report_failure failed');
        return 'Not logged (internal error). Carry on normally.';
      }
    },
  });
}

export async function fileSelfReport(
  ctx: ToolContext,
  input: { categories: string[]; summary: string; signal: (typeof FAILURE_SIGNALS)[number]; messageTs?: string[] },
): Promise<string> {
  const categories = cleanCategories(input.categories);
  if (!categories.length) return 'Not logged: no valid category.';
  if ((await selfReportsToday(ctx.threadId)) >= FAILURE_LIMITS.selfPerThreadPerDay) return ALREADY_NOTED;
  const fallbackTs = getExtra(ctx.extras, EXTRAS.defaultReactTs);
  const given = (input.messageTs ?? []).map((t) => normalizeTs(t)).filter((t): t is string => !!t);
  let evidence = await evidenceFor(ctx.threadId, given);
  if (!evidence.length && fallbackTs) evidence = await evidenceFor(ctx.threadId, [fallbackTs]);
  const key = `failure:self:${ctx.threadId}:${ctx.turnId != null ? `turn:${ctx.turnId}` : `ts:${fallbackTs ?? 'none'}`}`;
  const id = await recordFailure({
    threadId: ctx.threadId,
    channelId: ctx.channelId,
    turnId: ctx.turnId ?? null,
    source: 'self',
    categories,
    summary: input.summary,
    signal: input.signal,
    evidence,
    speakerId: ctx.speakerId,
    idempotencyKey: key,
  });
  if (id == null) return ALREADY_NOTED;
  log.info({ threadId: ctx.threadId, turnId: ctx.turnId, reportId: id, categories }, 'failure self-reported');
  return NOTED;
}

export function registerReportFailureTool() {
  registerTool({ name: 'report_failure', roles: ['front'], build: reportFailureTool });
}
