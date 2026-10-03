/** read_thread / read_channel: older messages of the CURRENT thread/channel (bot token), in the context format. */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../core/tools.js';
import { renderRawMessages } from '../context/thread.js';
import { fetchHistoryBefore, fetchReplies, fromSlack } from '../context/slack-messages.js';
import type { RenderMsg } from '../context/format.js';
import { log } from '../log.js';
import { errMsg, normalizeTs, untrusted } from './util.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const inputSchema = z.object({
  before_ts: z.string().optional().describe('Only messages strictly older than this message ts (the bracketed number in context). Omit for the latest.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`How many messages (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
});

const visible = (raws: any[]) => raws.map(fromSlack).filter((m): m is RenderMsg => !!m);

registerTool({
  name: 'read_thread',
  roles: ['front', 'child'],
  build: (ctx) =>
    tool({
      description:
        'Read messages of the CURRENT Slack thread (this conversation only), e.g. earlier replies not shown in context. Returns up to `limit` messages before `before_ts` (oldest first). To read any other thread (e.g. a search hit), use read_public_thread.',
      inputSchema,
      execute: async ({ before_ts, limit }) => {
        const before = normalizeTs(before_ts);
        if (before_ts && !before) return `Invalid before_ts "${before_ts}" — use a message ts like 1727950000.123456.`;
        const n = limit ?? DEFAULT_LIMIT;
        try {
          const raws = await fetchReplies(ctx.channelId, ctx.threadTs, { latest: before, maxMessages: 2000 });
          const msgs = visible(raws);
          const parent = msgs.find((m) => m.ts === ctx.threadTs);
          const replies = msgs.filter((m) => m.ts !== ctx.threadTs);
          const slice = replies.slice(-n);
          const earlier = replies.length - slice.length;
          // Show the parent only when the window reaches back to it.
          const shown = earlier === 0 && parent ? [parent, ...slice] : slice;
          if (!shown.length) return before ? `No messages in this thread before ${before}.` : 'This thread has no messages.';
          const body = await renderRawMessages(ctx.threadId, shown);
          const head = earlier > 0 ? `[${earlier} earlier ${earlier === 1 ? 'reply' : 'replies'} — call read_thread with before_ts=${slice[0]!.ts}]\n` : '';
          return untrusted('slack thread', head + body);
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
        "Read top-level messages of the current Slack channel (not thread replies). Returns up to `limit` messages before `before_ts` (oldest first). Only works in channels the bot is in.",
      inputSchema,
      execute: async ({ before_ts, limit }) => {
        const before = normalizeTs(before_ts);
        if (before_ts && !before) return `Invalid before_ts "${before_ts}" — use a message ts like 1727950000.123456.`;
        const n = limit ?? DEFAULT_LIMIT;
        try {
          // Over-fetch a little: joins/leaves are filtered out.
          const raws = await fetchHistoryBefore(ctx.channelId, { latest: before, limit: Math.min(n + 10, 100) });
          const shown = visible(raws).slice(-n);
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
