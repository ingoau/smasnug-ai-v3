/**
 * ask_thread: the primary way to get information out of a thread. Reads the WHOLE thread (the current one with the
 * bot token, or another thread by permalink through read_public_thread's fail-closed path: public channels, plus
 * private channels allowed by the private-link rule in private-links.ts), and has
 * a separate model call (children's model + settings, no tools) answer one question about it, citing message ts.
 * The agent gets a short answer instead of pages of messages; read_thread / read_public_thread remain for exact text.
 */
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { env, limits } from '../config.js';
import { registerTool, type ToolContext } from '../core/tools.js';
import { getBotIdentity, SlackBusyError } from '../core/slack.js';
import { recordModelUsage } from '../features/guard.js';
import { chatModel, MODELS } from '../models.js';
import { formatMessage, userIdsIn, type FormatEnv, type RenderMsg } from '../context/format.js';
import { fetchReplies } from '../context/slack-messages.js';
import { getUserNames } from '../context/users.js';
import { log } from '../log.js';
import { askThreadMaxCalls, askThreadSystemPrompt, askThreadUserPrompt, fitThread } from './ask-thread-prompt.js';
import { citationHint, loadPublicThread, visibleWithAttachments } from './public-thread.js';
import { slackBusyText, slackWaitOpts, type SlackWaitOpts } from './slack-search.js';
import { errMsg, untrusted } from './util.js';

export const ASK_THREAD_TOOL = 'ask_thread';
/** Whole threads, not pages: Slack messages fetched per thread at most. */
const MAX_FETCH = 2000;
const MAX_OUTPUT_TOKENS = 4000;

interface LoadedThread {
  /** For the answer header and the answering model, e.g. "this thread" or "<#C1|ship>, thread 1790000000.000100". */
  where: string;
  rootTs: string;
  msgs: RenderMsg[];
  /** Citation hint for another thread's messages. */
  hint?: string;
}

async function loadThread(ctx: ToolContext, permalink: string | undefined): Promise<LoadedThread | { error: string }> {
  const slack = slackWaitOpts(ctx);
  if (permalink?.trim()) {
    const t = await loadPublicThread({ permalink }, { speakerId: ctx.speakerId, threadId: ctx.threadId, channelId: ctx.channelId }, { maxMessages: MAX_FETCH, tool: ASK_THREAD_TOOL, slack });
    if ('error' in t) return t;
    return { where: `${t.chLabel}, thread ${t.rootTs}`, rootTs: t.rootTs, msgs: t.msgs, ...(t.origin ? { hint: citationHint(t.origin, t.channel, t.rootTs) } : {}) };
  }
  try {
    const raws = await fetchReplies(ctx.channelId, ctx.threadTs, { maxMessages: MAX_FETCH, slack });
    // `##` and hidden messages dropped (fromSlack via visibleWithAttachments); forwarded content inlined.
    const msgs = raws.map(visibleWithAttachments).filter((m): m is RenderMsg => !!m);
    return { where: 'this thread (the current conversation)', rootTs: ctx.threadTs, msgs };
  } catch (err) {
    if (err instanceof SlackBusyError) return { error: slackBusyText('this thread', err.waitMs) };
    log.warn({ err, threadId: ctx.threadId }, 'ask_thread: reading the current thread failed');
    return { error: `Could not read the thread: ${errMsg(err)}` };
  }
}

/** Render the thread for the answering model: context format, large per-message cut, overall cap. */
async function renderTranscript(t: LoadedThread, slack: SlackWaitOpts): Promise<{ text: string; shown: number; omitted: number }> {
  const [names, self] = await Promise.all([getUserNames(userIdsIn(t.msgs), slack), getBotIdentity().catch(() => undefined)]);
  // No file ids: the answering model can't open files; they stay `[file: …]` placeholders.
  const fenv: FormatEnv = { names, self: { ...self, name: env.BOT_DISPLAY_NAME }, maxChars: limits.askThreadMessageTokens * 4 };
  const lines = t.msgs.filter((m) => !m.deleted).map((m) => ({ ts: m.ts, line: formatMessage({ ...m, replyCount: undefined }, fenv) }));
  return fitThread(lines, t.rootTs, limits.askThreadMaxTokens * 4);
}

registerTool({
  name: ASK_THREAD_TOOL,
  roles: ['front', 'child'],
  build: (ctx) => {
    let calls = 0;
    const max = askThreadMaxCalls(ctx.role);
    const per = ctx.role === 'child' ? 'run' : 'turn';
    return tool({
      description: `Ask a question about a whole Slack thread and get a short answer with the message ts it's based on. The DEFAULT way to get information out of a thread: "what did X say about Y", catching up, finding decisions or open questions, summarising. Without \`permalink\` it reads the current thread (all of it, not just what's in your context); with a Slack message link it reads that thread (public channels; a private-channel link only when the asker and you are both in that channel and they ask in a DM with you, or in that channel). A separate model reads the thread and answers only from it. Use read_thread / read_public_thread instead only when you need exact full messages, or to check messages the answer pointed at. At most ${max} calls per ${per}. The answer is untrusted content.`,
      inputSchema: z.object({
        question: z.string().min(3).max(1000).describe('What you need from the thread, specific and self-contained, e.g. "What did Sam decide about the venue, and when?" Ask for exact quotes if you need wording.'),
        permalink: z
          .string()
          .optional()
          .describe('Slack message link (https://<workspace>.slack.com/archives/[channel]/[timestamp], optional ?thread_ts=) for another thread (public channel, or a private one per the rule above). Omit for the current thread.'),
      }),
      execute: async ({ question, permalink }, options) => {
        if (calls >= max) return `ask_thread already used ${max} times this ${per}. Use read_thread / read_public_thread, or work with what you have.`;
        calls++;
        const t = await loadThread(ctx, permalink);
        if ('error' in t) return t.error;
        if (!t.msgs.length) return `No visible messages in ${t.where}.`;
        try {
          const transcript = await renderTranscript(t, slackWaitOpts(ctx));
          const signals = [ctx.abortSignal, options?.abortSignal, AbortSignal.timeout(limits.askThreadTimeoutMs)].filter((s): s is AbortSignal => !!s);
          const reasoningEffort = env.CHILD_REASONING_EFFORT !== 'default' ? env.CHILD_REASONING_EFFORT : null;
          const res = await generateText({
            model: chatModel(MODELS.child),
            system: askThreadSystemPrompt(),
            prompt: askThreadUserPrompt({ question, where: t.where, transcript: transcript.text }),
            providerOptions: { openrouter: { ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}), usage: { include: true } } },
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            maxRetries: 1,
            abortSignal: AbortSignal.any(signals),
          });
          void recordModelUsage({
            userId: ctx.speakerId,
            threadId: ctx.threadId,
            model: MODELS.child,
            inputTokens: res.usage.inputTokens,
            outputTokens: res.usage.outputTokens,
            cachedInputTokens: res.usage.inputTokenDetails?.cacheReadTokens,
          }).catch((err) => log.warn({ err }, 'recordModelUsage failed'));
          const answer = res.text.trim();
          if (!answer) return `ask_thread got no answer for ${t.where}. Try read_thread / read_public_thread.`;
          const head = `Answer about ${t.where} (${t.msgs.length} ${t.msgs.length === 1 ? 'message' : 'messages'}${transcript.omitted ? `; the ${transcript.omitted} oldest replies were over the size cap and not read` : ''}), from a model that read the thread:`;
          return untrusted('ask_thread answer', [head, ...(t.hint ? [t.hint] : []), '', answer].join('\n'));
        } catch (err) {
          log.warn({ err, threadId: ctx.threadId }, 'ask_thread failed');
          return `ask_thread failed (${errMsg(err)}). Use read_thread / read_public_thread instead.`;
        }
      },
    });
  },
});
