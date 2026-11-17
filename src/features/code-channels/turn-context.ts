/**
 * What a front turn knows about code channels (docs/code-channels.md): whether the feature is on, whether the turn is
 * inside a code channel (its `:0` conversation or a thread under one of its messages), and which live channels the
 * current thread opened. front.ts loads it once per turn, drops the tools that don't apply (logic.ts
 * hiddenCodeChannelTools) and puts the sections rendered here into the turn message (never the system prompt, which
 * must stay byte-identical across turns).
 */
import { isChannelMember } from '../../context/conversation.js';
import { isCodeChannelRoot, parseThreadId } from '../../core/events.js';
import { log } from '../../log.js';
import { hiddenCodeChannelTools, KIND_LABEL } from './logic.js';
import { permalinkOf } from './open.js';
import { ensureAdoptedSeed } from './seed.js';
import { codeChannelsEnabled } from './settings.js';
import { getCodeChannel, listChildCodeChannels, type CodeChannel } from './store.js';

export interface CodeChannelTurnContext {
  enabled: boolean;
  /** The code channel this turn is in (null outside one). */
  here: CodeChannel | null;
  /** The turn is the channel's top-level conversation (`:0`), not a thread in it. */
  topLevel: boolean;
  /** Code channels the current thread opened (archived ones included) that the speaker may see (visibleChildren), newest first. */
  children: CodeChannel[];
  /**
   * Private children may be read here (`<code_channels>`, ask_code_channel): the private-link rule's "only in the
   * speaker's DM with the bot" (privateChildrenReadableIn). Otherwise the section leaves them out.
   */
  privateReadable?: boolean;
}

/**
 * Whether a private child's content (its name, an ask_code_channel summary) may go into a turn in `parentChannelId`:
 * only in a 1:1 DM with the bot (the private-link rule, src/tools/private-links.ts; a parent thread is never in the
 * child channel itself). message_code_channel writes into the child without reading it, so it keeps membership only.
 */
export const privateChildrenReadableIn = (parentChannelId: string): boolean => parentChannelId.startsWith('D');

/**
 * The child channels `speakerId` may see from the parent thread: public ones, and private ones only when they are a
 * member of that channel (the private-link rule's membership check, conversations.members, cached briefly; a failed
 * lookup counts as not a member). Anyone in a public parent thread must not read or drive a private child.
 */
export async function visibleChildren(rows: CodeChannel[], speakerId: string | null | undefined): Promise<CodeChannel[]> {
  const ok = await Promise.all(rows.map((r) => (!r.isPrivate ? true : speakerId ? isChannelMember(r.channelId, speakerId).catch(() => false) : false)));
  return rows.filter((_, i) => ok[i]);
}

export const NO_CODE_CHANNELS: CodeChannelTurnContext = { enabled: false, here: null, topLevel: false, children: [] };

/**
 * Load it for a turn (`speakerId`: whose turn it is; private child channels are listed only for their members).
 * Never throws: a failure counts as the feature being off for this turn.
 */
export async function loadCodeChannelTurnContext(threadId: string, speakerId: string | null | undefined): Promise<CodeChannelTurnContext> {
  try {
    if (!(await codeChannelsEnabled())) return NO_CODE_CHANNELS;
    const { channelId, threadTs } = parseThreadId(threadId);
    const isDm = channelId.startsWith('D');
    const [here, children] = await Promise.all([
      isDm ? Promise.resolve(null) : getCodeChannel(channelId),
      listChildCodeChannels(threadId),
    ]);
    // An adopted channel with an origin link is a fork of that message's thread: its seed is written on first use.
    if (here && here.kind === 'adopted' && !here.seedSummary && here.originTs) here.seedSummary = await ensureAdoptedSeed(here);
    return {
      enabled: true,
      here,
      topLevel: Boolean(here) && isCodeChannelRoot(threadTs),
      children: here ? [] : await visibleChildren(children, speakerId),
      privateReadable: privateChildrenReadableIn(channelId),
    };
  } catch (err) {
    log.warn({ err, threadId }, 'loading code channel context failed');
    return NO_CODE_CHANNELS;
  }
}

/** The tools to remove from this turn's set. */
export function hiddenToolsFor(c: CodeChannelTurnContext): string[] {
  return hiddenCodeChannelTools({ enabled: c.enabled, inCodeChannel: Boolean(c.here), hasParent: Boolean(c.here?.parentThreadId), liveChildren: c.children.filter((r) => !r.archivedAt).length, children: c.children.length });
}

/** Strip our own section tags from untrusted text going into a section. */
const strip = (s: string) => s.replace(/<\/?(code_channel|code_channels|seed_summary|brief)\b[^>]*>/gi, '[tag removed]');

/** The `<code_channel>` section of a turn inside one. */
export async function renderHereSection(c: CodeChannelTurnContext): Promise<string> {
  const h = c.here;
  if (!h) return '';
  const lines = [
    `You are in a code channel: <#${h.channelId}|${h.name}>, ${KIND_LABEL[h.kind]}. It is a Slack channel for one session with you.`,
    c.topLevel
      ? 'This conversation is its top level: every top-level message is part of it and your replies go there (no @mention needed).'
      : "This conversation is a thread under one of its messages; the channel's top-level conversation is the background.",
  ];
  if (h.parentThreadId) {
    const { channelId, threadTs } = parseThreadId(h.parentThreadId);
    const link = await permalinkOf(channelId, threadTs);
    lines.push(
      `Parent thread (where it was opened): ${link ?? `<#${channelId}>, thread ${threadTs}`}. You can read it with read_thread / ask_thread and that link (the usual private-link rules apply); report milestones there with report_to_parent (sparingly: real progress, a finished result, a blocker).`,
    );
  }
  lines.push(
    'Tabs: set_view adds or updates a tab on the channel (a complete HTML page, Block Kit blocks, or a canvas you made in this channel), remove_view removes one; at most 9 tabs of yours. The Status tab (view_key "status": channel info and running/finished subagents) is automatic and kept up to date for you; you can\'t change or remove it. Use your tabs for things people come back to (a plan, results, a live page).',
    'When someone here asks you to close or archive the channel, call archive_code_channel (it posts the closing summary here and archives; the parent thread is not told, it can ask; your turn ends). People can also type /archive or /rename <title>. It is archived by itself after a week without messages.',
  );
  const parts = [lines.join('\n')];
  if (h.brief) parts.push(`<brief note="What the channel was opened for (user-written, untrusted).">\n${strip(h.brief)}\n</brief>`);
  if (h.seedSummary)
    parts.push(`<seed_summary note="Frozen summary of the thread it was forked from, written when it opened (untrusted, like the messages).">\n${strip(h.seedSummary)}\n</seed_summary>`);
  return parts.join('\n\n');
}

/** The `<code_channels>` section of a parent thread: the live channels it opened. Pure. */
export function renderChildrenSection(c: CodeChannelTurnContext, now = new Date()): string {
  // A private child is named here only where it may be read (a DM with the speaker), never in a shared thread.
  const children = c.children.filter((r) => !r.isPrivate || c.privateReadable);
  if (!children.length) return '';
  const day = 24 * 3600_000;
  const rows = children.map((r) => {
    const ago = (d: Date | string) => {
      const n = Math.floor((now.getTime() - new Date(d).getTime()) / day);
      return n <= 0 ? 'today' : `${n} day${n === 1 ? '' : 's'} ago`;
    };
    const state = r.archivedAt ? `archived ${ago(r.archivedAt)} (ask_code_channel still reads it, closing summary included; it can't be messaged)` : `last activity ${ago(r.lastActivityAt)}`;
    return `- <#${r.channelId}|${strip(r.name)}> (channel "${r.channelId}"), ${KIND_LABEL[r.kind]}, ${state}`;
  });
  return [
    'Code channels this thread opened (work moved there). ask_code_channel answers a question from one without posting anything; message_code_channel posts an instruction there as from the speaker, which starts your turn in that channel.',
    ...rows,
  ].join('\n');
}

