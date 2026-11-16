/**
 * The agent's code-channel tools (docs/code-channels.md), all front-only and gated per turn by front.ts
 * (turn-context.ts hiddenToolsFor; each tool re-checks what it relies on when it runs):
 * - outside code channels: `open_code_channel`, and the `move_to_code_channel` button action;
 * - inside one: `set_view`, `remove_view`, `report_to_parent`, `archive_code_channel`;
 * - in a thread that opened live ones: `ask_code_channel`, `message_code_channel`.
 * Invites that need the requester's go-ahead get an ephemeral confirmation (`cc_invite:confirm` / `cc_invite:cancel`).
 */
import { createHash } from 'node:crypto';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { env, limits } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { registerAction } from '../../core/actions.js';
import { appendEvent, parseThreadId, threadTsArg } from '../../core/events.js';
import { getBotIdentity, slackCall } from '../../core/slack.js';
import { registerTool, type ToolContext } from '../../core/tools.js';
import { getConversationInfo, isChannelMember } from '../../context/conversation.js';
import { annotateTsDates, formatMessage, userIdsIn, type FormatEnv, type RenderMsg } from '../../context/format.js';
import { fetchConversationHistory } from '../../context/slack-messages.js';
import { getUserNames } from '../../context/users.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { chatModel, MODELS, modelOptions } from '../../models.js';
import { registerButtonAction } from '../../agent/button-actions.js';
import { loadReplyButtons } from '../../agent/reply-buttons-store.js';
import { turnState } from '../../agent/turn-state.js';
import { askThreadSystemPrompt, askThreadUserPrompt, fitThread } from '../../tools/ask-thread-prompt.js';
import { visibleWithAttachments } from '../../tools/public-thread.js';
import { errMsg, untrusted } from '../../tools/util.js';
import { recordModelUsage } from '../guard.js';
import { ephemeral } from '../util.js';
import { listCodeChannelViews, removeCodeChannelView, setCodeChannelView, VIEW_CONTENT_MAX_BYTES, VIEW_RESOURCE_DOMAINS_MAX, type CodeChannelView } from './api.js';
import { CodeChannelError } from './errors.js';
import { deriveSessionId } from './ids.js';
import {
  decodeInviteValue,
  encodeInviteValue,
  inviteConfirmText,
  isCompleteHtml,
  MAX_INVITES,
  movedNote,
  parseChannelRef,
  parseUserId,
  partitionInvites,
  pickOrigin,
  sourceLinkText,
} from './logic.js';
import { closeCodeChannel, handleArchiveSlash, handleRenameSlash } from './lifecycle.js';
import { inviteUsers, isDmConversation, openCodeChannel, parentLabel, postInThread, postParentMessage } from './open.js';
import { codeChannelsEnabled } from './settings.js';
import { getCodeChannel, isCodeChannel, listChildCodeChannels, type CodeChannel } from './store.js';
import { visibleChildren } from './turn-context.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
/** Slack allows 10 tabs per channel. */
export const MAX_VIEWS = 10;
const ASK_MAX_CALLS = 3;
const ASK_MAX_FETCH = 500;

const failText = (err: unknown) => (err instanceof CodeChannelError ? err.userMessage : `Something went wrong (${errMsg(err)}).`);

/** The latest message by a person (not a bot) in a thread. */
async function latestUserMessage(threadId: string, botUserId: string | undefined): Promise<{ ts: string; userId: string; text: string } | null> {
  const [row] = await sql<{ ts: string; userId: string; text: string }[]>`
    select ts, user_id, text from messages
    where thread_id = ${threadId} and not deleted and user_id is not null and bot_id is null ${botUserId ? sql`and user_id <> ${botUserId}` : sql``}
    order by ts::numeric desc limit 1`;
  return row ?? null;
}

/** Post the requester's confirmation for invites that need it (ephemeral, in the source thread). */
async function askInviteConfirmation(threadId: string, requesterId: string, channelId: string, users: string[]): Promise<void> {
  const { channelId: ch, threadTs } = parseThreadId(threadId);
  const value = encodeInviteValue({ c: channelId, u: users, r: requesterId });
  const text = inviteConfirmText({ channelId, users });
  await slackCall(
    'chat.postEphemeral',
    {
      channel: ch,
      user: requesterId,
      ...threadTsArg(threadTs),
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            { type: 'button', action_id: 'cc_invite:confirm', text: { type: 'plain_text', text: 'Invite' }, style: 'primary', value },
            { type: 'button', action_id: 'cc_invite:cancel', text: { type: 'plain_text', text: "Don't invite" }, value },
          ],
        },
      ],
    },
    { idempotencyKey: `cc-invite-confirm:${channelId}:${hash(users.join(','))}` },
  );
}

/** A live child code channel of this thread, from the model's reference; or why not. */
async function resolveChild(threadId: string, ref: string, speakerId: string): Promise<CodeChannel | string> {
  const id = parseChannelRef(ref);
  // Private children the speaker isn't in are as good as absent (not named, not listed): no leak.
  const children = await visibleChildren(await listChildCodeChannels(threadId), speakerId);
  const row = id ? children.find((c) => c.channelId === id) : children.find((c) => c.name.toLowerCase().includes(ref.trim().toLowerCase()));
  if (!row) return `That isn't a code channel this thread opened. Channels: ${children.map((c) => `<#${c.channelId}> ("${c.channelId}")`).join(', ') || 'none'}.`;
  if (row.archivedAt) return `<#${row.channelId}> is archived.`;
  return row;
}

// ---- open_code_channel ------------------------------------------------------------------------------------------

function openTool(ctx: ToolContext) {
  let n = 0;
  return tool({
    description:
      'Open a code channel: a new Slack channel for one session with you (a long task, a build, debugging, a side project), where everyone talks to you without @mentions. ' +
      'Either `brief` (a new task: posted as the channel\'s first message and you start on it there) or `fork: true` (move this thread\'s current topic there: a summary of the thread so far is posted, the latest message is answered there, and a link goes into this thread; your turn here ends). ' +
      'Only when the speaker asks for one, or agreed to your offer. The speaker is invited; `members` are invited too (people already in this conversation directly, anyone else after the speaker confirms privately). The channel is private if this conversation is (or with private: true).',
    inputSchema: z.object({
      name: z.string().min(1).max(150).describe('Short name for the work, e.g. "login bug". The channel is called "<your name>: <name>".'),
      brief: z.string().max(4000).optional().describe('What to do there, self-contained (for a new task). Omit with fork.'),
      fork: z.boolean().optional().describe('true: move this thread\'s current topic into the channel.'),
      members: z.array(z.string()).max(MAX_INVITES).optional().describe('People to invite besides the speaker: <@U…> or user ids.'),
      private: z.boolean().optional().describe('Make it private even though this conversation is public.'),
    }),
    execute: async (input) => {
      const s = turnState(ctx);
      if (!(await codeChannelsEnabled())) return "Code channels are switched off right now. Tell the speaker briefly.";
      if (await isCodeChannel(ctx.channelId)) return "You're already in a code channel: they can't be nested.";
      const fork = input.fork === true;
      const brief = input.brief?.trim();
      if (fork && brief) return 'Pass either `brief` (a new task) or `fork: true` (move this thread), not both.';
      if (!fork && !brief) return 'Pass `brief` (what to do there) or `fork: true` (move this thread\'s topic there).';
      const index = n++;
      const bot = await getBotIdentity().catch(() => undefined);
      const latest = await latestUserMessage(ctx.threadId, bot?.userId);
      const triggerTs = [...(s.turn.messageTs ?? [])].sort((a, b) => Number(b) - Number(a))[0] ?? null;
      const origin = pickOrigin({ fork, triggerTs, latestUserMessage: latest });
      if (fork && !latest) return 'There is no message from a person in this thread to fork from.';

      const info = await getConversationInfo(ctx.channelId).catch(() => null);
      const originIsDm = isDmConversation(ctx.channelId, info);
      const ids = (input.members ?? []).map((m) => parseUserId(m)).filter((x): x is string => !!x);
      const membership = new Map(await Promise.all(ids.map(async (u) => [u, originIsDm ? false : await isChannelMember(ctx.channelId, u)] as const)));
      const exclude = new Set([ctx.speakerId, ...(bot?.userId ? [bot.userId] : [])]);
      const invites = partitionInvites({ members: input.members ?? [], originIsDm, isOriginMember: (u) => membership.get(u) === true, exclude });

      let opened;
      try {
        opened = await openCodeChannel({
          mode: fork ? 'fork' : 'task',
          name: input.name,
          sessionId: deriveSessionId({ via: 'tool', turnId: String(ctx.turnId ?? s.turn.id), n: index }),
          sourceThreadId: ctx.threadId,
          originTs: origin?.ts ?? null,
          originAuthorId: origin?.authorId ?? null,
          requesterId: ctx.speakerId,
          createdBy: ctx.speakerId,
          explicitInvites: [ctx.speakerId, ...invites.direct],
          private: input.private,
          ...(brief ? { brief } : {}),
          ...(fork && latest ? { handoff: { authorId: latest.userId, text: latest.text } } : {}),
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        });
      } catch (err) {
        log.warn({ err, threadId: ctx.threadId }, 'open_code_channel failed');
        return `Couldn't open the code channel: ${failText(err)} Nothing was created. Tell the speaker briefly.`;
      }
      const ch = opened.channel.channelId;
      const notes: string[] = [];
      if (opened.problems.length) notes.push(`Problems: ${opened.problems.join('; ')}.`);
      if (invites.invalid.length) notes.push(`Not user ids, skipped: ${invites.invalid.join(', ')}.`);
      if (invites.confirm.length) {
        await askInviteConfirmation(ctx.threadId, ctx.speakerId, ch, invites.confirm)
          .then(() => notes.push(`${invites.confirm.map((u) => `<@${u}>`).join(', ')} ${invites.confirm.length === 1 ? 'is' : 'are'} only invited once the speaker confirms (they see a private prompt).`))
          .catch((err) => (log.warn({ err }, 'invite confirmation failed'), notes.push('Asking the speaker to confirm the other invites failed.')));
      }
      if (fork) {
        const ts = await postInThread(ctx.threadId, sourceLinkText({ channelId: ch, ...(opened.seedPermalink ? { seedPermalink: opened.seedPermalink } : {}) }), `cc-link:${ch}`).catch((err) => {
          log.warn({ err, channelId: ch }, 'code channel source link failed');
          return null;
        });
        if (ts) s.visible.add('code_channel');
        s.endRequested = true;
        return [`Forked into <#${ch}>: the summary and the latest message are posted there and will be answered there.${ts ? ' A link to it is posted in this thread.' : ''}`, ...notes, 'Your turn here is over: do not reply.'].join(' ');
      }
      return [
        `Opened <#${ch}> ${opened.seedPermalink ? `(${opened.seedPermalink}) ` : ''}with the brief as its first message; you will start on it there by yourself.`,
        ...notes,
        'Tell the speaker in one short reply, with the channel link. Don\'t start the work here.',
      ].join(' ');
    },
  });
}

// ---- move_to_code_channel (button) ------------------------------------------------------------------------------

const moveArgs = z.object({ name: z.string().min(1).max(150) });

async function moveCheck(channelId: string): Promise<string | null> {
  if (!(await codeChannelsEnabled())) return 'code channels are switched off';
  if (await isCodeChannel(channelId)) return "this is a code channel already (they can't be nested)";
  return null;
}

// ---- views -----------------------------------------------------------------------------------------------------

const viewSchema = z.object({
  view_key: z.string().min(1).max(256).describe('Stable key for the tab: the same key updates it.'),
  type: z.enum(['html', 'block_kit', 'canvas']),
  name: z.string().min(1).max(60).describe('The tab label.'),
  content: z.string().optional().describe('type html: a complete, self-contained HTML document (<html>…</html>, ≤ 1 MB). It renders sandboxed under a strict CSP.'),
  blocks: z.array(z.unknown()).optional().describe('type block_kit: Block Kit blocks.'),
  canvas_id: z.string().optional().describe('type canvas: a canvas you made in this channel (create_canvas), F…'),
  access_level: z.enum(['read', 'write', 'comment']).optional().describe('type canvas: what members can do (default read).'),
  csp_domains: z.array(z.string()).max(VIEW_RESOURCE_DOMAINS_MAX).optional().describe(`type html: https origins the page may load from (≤ ${VIEW_RESOURCE_DOMAINS_MAX}).`),
});

/** set_view input → the view, or why not (pure apart from the canvas lookup). */
async function toView(channelId: string, v: z.infer<typeof viewSchema>): Promise<CodeChannelView | string> {
  if (v.type === 'html') {
    if (!v.content?.trim()) return 'type html needs `content` (a complete HTML document).';
    if (!isCompleteHtml(v.content)) return 'HTML tabs must be complete documents: <!doctype html><html>…</html>.';
    if (Buffer.byteLength(v.content, 'utf8') > VIEW_CONTENT_MAX_BYTES) return 'That page is over the 1 MB limit.';
    return { type: 'html', viewKey: v.view_key, name: v.name, content: v.content, ...(v.csp_domains?.length ? { resourceDomains: v.csp_domains } : {}) };
  }
  if (v.type === 'block_kit') {
    if (!v.blocks?.length) return 'type block_kit needs `blocks`.';
    if (v.blocks.length > 100) return 'At most 100 blocks.';
    return { type: 'block_kit', viewKey: v.view_key, name: v.name, blocks: v.blocks };
  }
  const id = v.canvas_id?.trim();
  if (!id || !/^F[A-Z0-9]+$/.test(id)) return 'type canvas needs `canvas_id` (F…).';
  const [row] = await sql<{ channelId: string }[]>`select channel_id from bot_canvases where canvas_id = ${id}`;
  if (!row) return 'That canvas isn\'t one you made: create it with create_canvas in this channel first.';
  if (row.channelId !== channelId) return 'That canvas was made in another conversation: only canvases you made in this channel can be tabs here.';
  return { type: 'canvas', viewKey: v.view_key, name: v.name, canvasId: id, accessLevel: v.access_level ?? 'read' };
}

// ---- ask_code_channel ------------------------------------------------------------------------------------------

async function askChannel(ctx: ToolContext, row: CodeChannel, question: string, signal?: AbortSignal): Promise<string> {
  const [raws, views] = await Promise.all([
    fetchConversationHistory(row.channelId, { maxMessages: ASK_MAX_FETCH }),
    listCodeChannelViews(row.channelId).catch(() => []),
  ]);
  const msgs = raws.map(visibleWithAttachments).filter((m): m is RenderMsg => !!m);
  const [names, self] = await Promise.all([getUserNames(userIdsIn(msgs)), getBotIdentity().catch(() => undefined)]);
  const fenv: FormatEnv = { names, self: { ...self, name: env.BOT_DISPLAY_NAME }, maxChars: limits.askThreadMessageTokens * 4 };
  const lines = msgs.filter((m) => !m.deleted).map((m) => ({ ts: m.ts, line: formatMessage({ ...m, replyCount: undefined }, fenv) }));
  const facts = [
    ...(row.brief ? [`[the channel's brief: ${row.brief}]`] : []),
    ...(row.seedSummary ? [`[summary of the thread it was forked from, written when it opened:\n${row.seedSummary}\n]`] : []),
    `[tabs: ${views.map((v) => `${v.name ?? v.view_key ?? '?'} (${v.type ?? '?'})`).join(', ') || 'none'}]`,
  ];
  const budget = limits.askThreadMaxTokens * 4 - facts.join('\n').length;
  const transcript = fitThread(lines, '', Math.max(10_000, budget));
  const reasoningEffort = env.CHILD_REASONING_EFFORT !== 'default' ? env.CHILD_REASONING_EFFORT : null;
  const signals = [ctx.abortSignal, signal, AbortSignal.timeout(limits.askThreadTimeoutMs)].filter((s): s is AbortSignal => !!s);
  const res = await generateText({
    model: chatModel(MODELS.child),
    system: askThreadSystemPrompt(),
    prompt: askThreadUserPrompt({ question, where: `the code channel <#${row.channelId}|${row.name}> (its top-level conversation)`, transcript: [...facts, transcript.text].join('\n') }),
    providerOptions: modelOptions({ effort: reasoningEffort }),
    maxOutputTokens: 4000,
    maxRetries: 1,
    abortSignal: AbortSignal.any(signals),
  });
  void recordModelUsage({ userId: ctx.speakerId, threadId: ctx.threadId, model: MODELS.child, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cachedInputTokens: res.usage.inputTokenDetails?.cacheReadTokens }).catch(
    (err) => log.warn({ err }, 'recordModelUsage failed'),
  );
  const answer = annotateTsDates(res.text.trim());
  if (!answer) return `No answer about <#${row.channelId}>. Try read_channel on it.`;
  return untrusted('ask_code_channel answer', `Answer about <#${row.channelId}> (${msgs.length} messages${transcript.omitted ? `; the ${transcript.omitted} oldest not read` : ''}), from a model that read it:\n\n${answer}`);
}

// ---- invite confirmation ---------------------------------------------------------------------------------------

export async function handleInviteConfirm(ctx: ActionContext): Promise<void> {
  const v = decodeInviteValue(ctx.value);
  if (!v) return ephemeral(ctx, "That button doesn't work any more.", { replace: true });
  if (!(await codeChannelsEnabled())) return ephemeral(ctx, 'Code channels are switched off right now.');
  if (ctx.userId !== v.r) return ephemeral(ctx, `Only <@${v.r}> can confirm that.`);
  const row = await getCodeChannel(v.c);
  if (!row || (row.requesterId !== v.r && row.createdBy !== v.r)) return ephemeral(ctx, "That isn't your code channel.", { replace: true });
  if (row.archivedAt) return ephemeral(ctx, `<#${v.c}> is archived.`, { replace: true });
  const err = await inviteUsers(v.c, v.u, `confirm:${hash(v.u.join(','))}`);
  if (row.parentThreadId) await appendEvent(row.parentThreadId, 'code_channel_invite', ctx.userId, { channelId: v.c, users: v.u, ok: !err }).catch(() => {});
  await ephemeral(ctx, err ? `Inviting them failed (${err}).` : `Invited ${v.u.map((u) => `<@${u}>`).join(', ')} to <#${v.c}> ✓`, { replace: true });
}

export async function handleInviteCancel(ctx: ActionContext): Promise<void> {
  await ephemeral(ctx, 'OK, not inviting them.', { replace: true });
}

// ---- registration ----------------------------------------------------------------------------------------------

export function registerCodeChannelTools(): void {
  registerTool({ name: 'open_code_channel', roles: ['front'], build: openTool });

  registerTool({
    name: 'set_view',
    roles: ['front'],
    build: (ctx) =>
      tool({
        description: `Add or update a tab on this code channel (keyed by view_key): a complete HTML page, Block Kit blocks, or a canvas you made in this channel. At most ${MAX_VIEWS} tabs per channel. Use for things people come back to (a status page, a plan, results), not for answers (reply).`,
        inputSchema: viewSchema,
        execute: async (input) => {
          const row = await getCodeChannel(ctx.channelId);
          if (!row) return 'Tabs only exist in code channels.';
          const view = await toView(ctx.channelId, input);
          if (typeof view === 'string') return view;
          try {
            const views = await listCodeChannelViews(ctx.channelId).catch(() => []);
            if (!views.some((v) => v.view_key === input.view_key) && views.length >= MAX_VIEWS) return `This channel already has ${MAX_VIEWS} tabs: remove one first (remove_view).`;
            await setCodeChannelView(ctx.channelId, view);
            await appendEvent(ctx.threadId, 'code_channel_view', ctx.speakerId, { viewKey: input.view_key, type: input.type, name: input.name }).catch(() => {});
            return `Tab "${input.name}" (${input.view_key}) is set.`;
          } catch (err) {
            return `Couldn't set the tab: ${failText(err)}`;
          }
        },
      }),
  });

  registerTool({
    name: 'remove_view',
    roles: ['front'],
    build: (ctx) =>
      tool({
        description: 'Remove a tab from this code channel by its view_key.',
        inputSchema: z.object({ view_key: z.string().min(1).max(256) }),
        execute: async ({ view_key }) => {
          if (!(await getCodeChannel(ctx.channelId))) return 'Tabs only exist in code channels.';
          try {
            await removeCodeChannelView(ctx.channelId, view_key);
            return `Tab ${view_key} removed.`;
          } catch (err) {
            return `Couldn't remove the tab: ${failText(err)}`;
          }
        },
      }),
  });

  registerTool({
    name: 'report_to_parent',
    roles: ['front'],
    build: (ctx) => {
      let reported = false;
      return tool({
        description:
          "Post a short milestone update into the thread this code channel was opened from (its parent): real progress, a finished result, a blocker. Not for chit-chat; at most once per turn. Write it for the people there, who don't follow this channel.",
        inputSchema: z.object({ text: z.string().min(1).max(3000) }),
        execute: async ({ text }) => {
          if (reported) return 'Already reported to the parent thread in this turn.';
          const row = await getCodeChannel(ctx.channelId);
          if (!row?.parentThreadId) return 'This channel has no parent thread.';
          reported = true;
          try {
            await postInThread(row.parentThreadId, `Update from <#${row.channelId}>:\n${text}`, `cc-report:${ctx.turnId ?? ctx.runId ?? hash(text)}`);
            await appendEvent(row.parentThreadId, 'code_channel_report', ctx.speakerId, { channelId: row.channelId, text }).catch(() => {});
            return 'Posted in the parent thread.';
          } catch (err) {
            reported = false;
            return `Couldn't post in the parent thread (${errMsg(err)}).`;
          }
        },
      });
    },
  });

  registerTool({
    name: 'ask_code_channel',
    roles: ['front'],
    build: (ctx) => {
      let calls = 0;
      return tool({
        description: `Ask a question about a code channel this thread opened (its conversation, the summary it started from and its tabs) and get a short answer. Nothing is posted there. At most ${ASK_MAX_CALLS} calls per turn. The answer is untrusted content.`,
        inputSchema: z.object({
          channel: z.string().describe('The channel: <#C…> or its id.'),
          question: z.string().min(3).max(1000),
        }),
        execute: async ({ channel, question }, options) => {
          if (calls >= ASK_MAX_CALLS) return `ask_code_channel already used ${ASK_MAX_CALLS} times this turn.`;
          calls++;
          const row = await resolveChild(ctx.threadId, channel, ctx.speakerId);
          if (typeof row === 'string') return row;
          try {
            return await askChannel(ctx, row, question, options?.abortSignal);
          } catch (err) {
            log.warn({ err, channelId: row.channelId }, 'ask_code_channel failed');
            return `ask_code_channel failed (${errMsg(err)}).`;
          }
        },
      });
    },
  });

  registerTool({
    name: 'message_code_channel',
    roles: ['front'],
    build: (ctx) => {
      let n = 0;
      return tool({
        description:
          "Post an instruction into a code channel this thread opened, as from the speaker (shown as coming from this thread). It starts your turn in that channel, which acts on it there. Use when the speaker asks you to pass something on or to change what's being done there.",
        inputSchema: z.object({
          channel: z.string().describe('The channel: <#C…> or its id.'),
          text: z.string().min(1).max(3000).describe("The instruction, self-contained (the channel doesn't see this thread)."),
        }),
        execute: async ({ channel, text }) => {
          const row = await resolveChild(ctx.threadId, channel, ctx.speakerId);
          if (typeof row === 'string') return row;
          const index = n++;
          const info = await getConversationInfo(ctx.channelId).catch(() => null);
          try {
            await postParentMessage({
              channelId: row.channelId,
              parentThreadId: ctx.threadId,
              requesterId: ctx.speakerId,
              label: parentLabel(info),
              text: `<@${ctx.speakerId}>: ${text}`,
              key: `cc-message:${ctx.turnId ?? hash(text)}:${index}`,
            });
            await appendEvent(ctx.threadId, 'code_channel_message', ctx.speakerId, { channelId: row.channelId, text }).catch(() => {});
            return `Posted in <#${row.channelId}>; your turn there acts on it.`;
          } catch (err) {
            return `Couldn't post in <#${row.channelId}> (${errMsg(err)}).`;
          }
        },
      });
    },
  });

  // The button (docs/code-channels.md, The button): anyone in the thread may press it. The origin is the reply that
  // carries it (its author is the bot, so the presser and the requester are invited explicitly); the seed is posted
  // and the channel waits for people (no turn).
  registerButtonAction({
    name: 'move_to_code_channel',
    args: moveArgs,
    who: 'anyone',
    check: (ctx) => moveCheck(ctx.channelId),
    run: async (ctx, a) => {
      const buttons = await loadReplyButtons(Number(ctx.key));
      if (!buttons?.messageTs) return { ok: false, text: "I couldn't find the reply that button is on." };
      const requesterId = buttons.requesterId ?? ctx.speakerId;
      try {
        const bot = await getBotIdentity().catch(() => undefined);
        const opened = await openCodeChannel({
          mode: 'button',
          name: a.name,
          sessionId: deriveSessionId({ via: 'button', replyButtonsId: String(buttons.id), index: buttons.pressedIndex ?? 0 }),
          sourceThreadId: buttons.threadId,
          originTs: buttons.messageTs,
          originAuthorId: bot?.userId ?? null,
          requesterId,
          createdBy: ctx.speakerId,
          explicitInvites: [ctx.speakerId, requesterId],
        });
        const ch = opened.channel.channelId;
        return {
          ok: true,
          text: `Moved to <#${ch}>${opened.problems.length ? ` (${opened.problems.join('; ')})` : ''}.`,
          note: movedNote({ channelId: ch, ...(opened.seedPermalink ? { seedPermalink: opened.seedPermalink } : {}) }),
        };
      } catch (err) {
        return { ok: false, text: failText(err) };
      }
    },
  });

  registerTool({
    name: 'archive_code_channel',
    roles: ['front'],
    build: (ctx) =>
      tool({
        description:
          'Close this code channel: writes a closing summary, posts it here and in the parent thread, and archives the channel. Only when someone here asks for it to be closed or archived. Ends your turn.',
        inputSchema: z.object({}),
        execute: async (_input, options) => {
          const row = await getCodeChannel(ctx.channelId);
          if (!row) return 'Only code channels can be archived this way.';
          if (row.archivedAt) return 'This channel is already archived.';
          const res = await closeCodeChannel({
            channelId: ctx.channelId,
            actor: ctx.speakerId,
            reason: 'agent',
            attemptKey: `turn:${ctx.turnId ?? ctx.runId ?? hash(ctx.threadId)}`,
            ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
          });
          if (!res.ok) return `${res.text} Tell the speaker briefly.`;
          const s = turnState(ctx);
          s.visible.add('code_channel');
          s.endRequested = true;
          return 'Archived: the closing summary is posted here and in the parent thread. Your turn is over: do not reply.';
        },
      }),
  });

  registerAction('cc_invite:confirm', handleInviteConfirm);
  registerAction('cc_invite:cancel', handleInviteCancel);
  // Per-channel slash commands (agents.conversations.setCommands, commands.ts). Slack may send them with or without
  // the slash; never collides with `/smasnug*` (registered earlier, matched by prefix).
  for (const name of ['/archive', 'archive']) registerAction(`slash:${name}`, handleArchiveSlash);
  for (const name of ['/rename', 'rename']) registerAction(`slash:${name}`, handleRenameSlash);
}
