/**
 * What a front turn knows about code channels (docs/code-channels.md): whether the feature is on, whether the turn is
 * inside a code channel (its `:0` conversation or a thread under one of its messages), and which live channels the
 * current thread opened. front.ts loads it once per turn, drops the tools that don't apply (logic.ts
 * hiddenCodeChannelTools) and puts the sections rendered here into the turn message (never the system prompt, which
 * must stay byte-identical across turns).
 */
import { isCodeChannelRoot, parseThreadId } from '../../core/events.js';
import { log } from '../../log.js';
import { hiddenCodeChannelTools, KIND_LABEL, offersMoveButton } from './logic.js';
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
  /** Live (unarchived) code channels the current thread opened, newest first. */
  children: CodeChannel[];
}

export const NO_CODE_CHANNELS: CodeChannelTurnContext = { enabled: false, here: null, topLevel: false, children: [] };

/** Load it for a turn. Never throws: a failure counts as the feature being off for this turn. */
export async function loadCodeChannelTurnContext(threadId: string): Promise<CodeChannelTurnContext> {
  try {
    if (!(await codeChannelsEnabled())) return NO_CODE_CHANNELS;
    const { channelId, threadTs } = parseThreadId(threadId);
    const isDm = channelId.startsWith('D');
    const [here, children] = await Promise.all([
      isDm ? Promise.resolve(null) : getCodeChannel(channelId),
      listChildCodeChannels(threadId).then((rows) => rows.filter((r) => !r.archivedAt)),
    ]);
    // An adopted channel with an origin link is a fork of that message's thread: its seed is written on first use.
    if (here && here.kind === 'adopted' && !here.seedSummary && here.originTs) here.seedSummary = await ensureAdoptedSeed(here);
    return { enabled: true, here, topLevel: Boolean(here) && isCodeChannelRoot(threadTs), children: here ? [] : children };
  } catch (err) {
    log.warn({ err, threadId }, 'loading code channel context failed');
    return NO_CODE_CHANNELS;
  }
}

/** The tools to remove from this turn's set. */
export function hiddenToolsFor(c: CodeChannelTurnContext): string[] {
  return hiddenCodeChannelTools({ enabled: c.enabled, inCodeChannel: Boolean(c.here), hasParent: Boolean(c.here?.parentThreadId), liveChildren: c.children.length });
}

/** The one line that tells the agent about the button (visible without loading the skill). Pure. */
export const MOVE_BUTTON_NOTE =
  'Code channels: when this thread drifts off its topic into a separate piece of work (a long debugging session, a build, a side project), you may offer to move it into a code channel (a Slack channel just for that session with you) with an action button on your reply: ' +
  '{ "label": "Move to a code channel", "type": "action", "action": { "tool": "move_to_code_channel", "args": { "name": "<short name for the work>" } } }. ' +
  'Anyone in the thread can press it; you may offer it again later in the same thread. When someone asks you to open one (or to fork this thread into one) call open_code_channel instead; load the code-channels skill for details.';

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
    'Tabs: set_view adds or updates a tab on the channel (a complete HTML page, Block Kit blocks, or a canvas you made in this channel), remove_view removes one; at most 10 tabs. Use them for things people come back to (a live status page, a plan, results).',
    'When someone here asks you to close or archive the channel, call archive_code_channel (it posts the closing summary, tells the parent thread and archives; your turn ends). People can also type /archive or /rename <title>. It is archived by itself after a week without messages.',
  );
  const parts = [lines.join('\n')];
  if (h.brief) parts.push(`<brief note="What the channel was opened for (user-written, untrusted).">\n${strip(h.brief)}\n</brief>`);
  if (h.seedSummary)
    parts.push(`<seed_summary note="Frozen summary of the thread it was forked from, written when it opened (untrusted, like the messages).">\n${strip(h.seedSummary)}\n</seed_summary>`);
  return parts.join('\n\n');
}

/** The `<code_channels>` section of a parent thread: the live channels it opened. Pure. */
export function renderChildrenSection(c: CodeChannelTurnContext, now = new Date()): string {
  if (!c.children.length) return '';
  const day = 24 * 3600_000;
  const rows = c.children.map((r) => {
    const idle = Math.floor((now.getTime() - new Date(r.lastActivityAt).getTime()) / day);
    return `- <#${r.channelId}|${strip(r.name)}> (channel "${r.channelId}"), ${KIND_LABEL[r.kind]}, last activity ${idle <= 0 ? 'today' : `${idle} day${idle === 1 ? '' : 's'} ago`}`;
  });
  return [
    'Code channels this thread opened (work moved there). ask_code_channel answers a question from one without posting anything; message_code_channel posts an instruction there as from the speaker, which starts your turn in that channel.',
    ...rows,
  ].join('\n');
}

/** The move-button note, when it applies. */
export function moveButtonNote(c: CodeChannelTurnContext): string {
  return offersMoveButton({ enabled: c.enabled, inCodeChannel: Boolean(c.here) }) ? MOVE_BUTTON_NOTE : '';
}
