/** read_thread / read_channel: pages of the CURRENT thread/channel (bot token), in the context format, capped by size. */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../core/tools.js';
import { renderRawMessages } from '../context/thread.js';
import { fetchHistoryBefore, fetchReplies, fromSlack } from '../context/slack-messages.js';
import { limits } from '../config.js';
import { estimateRenderedChars, pageThread, takeWithinBudget, threadPageHeader } from './paging.js';
import type { RenderMsg } from '../context/format.js';
import { log } from '../log.js';
import { errMsg, normalizeTs, untrusted } from './util.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const CHANNEL_MAX_LIMIT = 50;
const CHANNEL_DEFAULT_LIMIT = 20;
/** Page size cap (≈tokens → chars) for read_thread / read_channel pages. */
const PAGE_CHARS = limits.readPageTokens * 4;
const READ_CHARS = limits.readMessageTruncateTokens * 4;
const size = (m: RenderMsg) => estimateRenderedChars(m, READ_CHARS);

const visible = (raws: any[]) => raws.map(fromSlack).filter((m): m is RenderMsg => !!m);

const badTs = (name: string, v: string) => `Invalid ${name} "${v}" — use a message ts like 1727950000.123456.`;

registerTool({
  name: 'read_thread',
  roles: ['front', 'child'],
  build: (ctx) =>
    tool({
      description: `Read exact messages of the CURRENT Slack thread (this conversation only), a page at a time (oldest first on the page, ~${limits.readPageTokens} tokens max). Default: the newest replies. \`before_ts\` pages backwards (older), \`after_ts\` pages forwards (pass the thread's own ts to read from the start). The header says where the page is and how to continue. To read any other thread, use read_public_thread.`,
      inputSchema: z.object({
        before_ts: z.string().optional().describe('Only replies strictly older than this message ts (the bracketed number in context): pages backwards. Omit for the newest.'),
        after_ts: z.string().optional().describe("Only replies strictly newer than this ts: pages forwards. The thread's own ts reads from the start."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max messages on the page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); pages are also capped by size`),
      }),
      execute: async ({ before_ts, after_ts, limit }) => {
        const before = normalizeTs(before_ts);
        if (before_ts && !before) return badTs('before_ts', before_ts);
        const after = normalizeTs(after_ts);
        if (after_ts && !after) return badTs('after_ts', after_ts);
        try {
          const raws = await fetchReplies(ctx.channelId, ctx.threadTs, { maxMessages: 2000 });
          const page = pageThread(visible(raws), ctx.threadTs, { before, after, limit: limit ?? DEFAULT_LIMIT, maxChars: PAGE_CHARS, size });
          const shown = [...(page.parent ? [page.parent] : []), ...page.replies];
          if (!shown.length) return page.total ? `${threadPageHeader(page)}\nNo messages in that range.` : 'This thread has no messages.';
          const body = await renderRawMessages(ctx.threadId, shown);
          return untrusted('slack thread', `${threadPageHeader(page)}\n${body}`);
        } catch (err) {
          log.warn({ err, threadId: ctx.threadId }, 'read_thread failed');
          return `Could not read the thread: ${errMsg(err)}`;
        }
      },
    }),
});

registerTool({
  name: 'read_channel',
  roles: ['front', 'child'],
  build: (ctx) =>
    tool({
      description:
        `Read top-level messages of the current Slack channel (not thread replies). Returns up to \`limit\` messages before \`before_ts\` (oldest first, ~${limits.readPageTokens} tokens max). Only works in channels the bot is in. To read any other public channel, use read_public_channel.`,
      inputSchema: z.object({
        before_ts: z.string().optional().describe('Only messages strictly older than this message ts (the bracketed number in context). Omit for the latest.'),
        limit: z.number().int().min(1).max(CHANNEL_MAX_LIMIT).optional().describe(`How many messages (default ${CHANNEL_DEFAULT_LIMIT}, max ${CHANNEL_MAX_LIMIT}); pages are also capped by size`),
      }),
      execute: async ({ before_ts, limit }) => {
        const before = normalizeTs(before_ts);
        if (before_ts && !before) return badTs('before_ts', before_ts);
        const n = limit ?? CHANNEL_DEFAULT_LIMIT;
        try {
          // Over-fetch a little: joins/leaves are filtered out.
          const raws = await fetchHistoryBefore(ctx.channelId, { latest: before, limit: Math.min(n + 10, 100) });
          const shown = takeWithinBudget(visible(raws), 'backward', { maxChars: PAGE_CHARS, maxCount: n, size });
          if (!shown.length) return before ? `No channel messages before ${before}.` : 'No messages in this channel.';
          const body = await renderRawMessages(ctx.threadId, shown);
          return untrusted('slack channel', `${body}\n[older messages: call read_channel with before_ts=${shown[0]!.ts}]`);
        } catch (err) {
          log.warn({ err, channel: ctx.channelId }, 'read_channel failed');
          return `Could not read the channel: ${errMsg(err)}`;
        }
      },
    }),
});
