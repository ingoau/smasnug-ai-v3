/**
 * Pure decisions for the agent side of code channels (docs/code-channels.md, Opening one / Inside the channel /
 * Parent link): which tools a turn gets, the origin link, who is invited directly, and the texts code posts.
 * No Slack, database or model access (unit-tested in logic.test.ts).
 */

/** Opening a channel (front, outside code channels). */
export const OPEN_TOOLS = ['open_code_channel'] as const;
/** Inside a code channel (its `:0` conversation or a thread in it). report_to_parent also needs a parent thread. */
export const IN_CHANNEL_TOOLS = ['set_view', 'remove_view', 'report_to_parent', 'archive_code_channel'] as const;
/** In a thread that is the parent of a live (unarchived) code channel. */
export const PARENT_TOOLS = ['ask_code_channel', 'message_code_channel'] as const;
export const ALL_CODE_CHANNEL_TOOLS = [...OPEN_TOOLS, ...IN_CHANNEL_TOOLS, ...PARENT_TOOLS] as const;

export interface ToolGateInput {
  /** codeChannelsEnabled() */
  enabled: boolean;
  /** The turn's channel is a code channel. */
  inCodeChannel: boolean;
  /** That code channel has a parent thread. */
  hasParent: boolean;
  /** Live code channels this thread opened. */
  liveChildren: number;
}

/** The code-channel tools a turn must not get (removed from the built tool set). */
export function hiddenCodeChannelTools(g: ToolGateInput): string[] {
  if (!g.enabled) return [...ALL_CODE_CHANNEL_TOOLS];
  const hidden: string[] = [];
  // No nesting: no opening from inside one, and a code channel's threads are never a parent.
  if (g.inCodeChannel) hidden.push(...OPEN_TOOLS, ...PARENT_TOOLS);
  else hidden.push(...IN_CHANNEL_TOOLS);
  if (g.inCodeChannel && !g.hasParent) hidden.push('report_to_parent');
  if (!g.inCodeChannel && g.liveChildren === 0) hidden.push(...PARENT_TOOLS);
  return hidden;
}

/** Whether the front prompt offers the "Move to a code channel" button (enabled, not already in one). */
export function offersMoveButton(g: Pick<ToolGateInput, 'enabled' | 'inCodeChannel'>): boolean {
  return g.enabled && !g.inCodeChannel;
}

export interface OriginInput {
  fork: boolean;
  /** The message that triggered the turn (its latest), if any. */
  triggerTs?: string | null;
  /** The latest message by a person in the current thread. */
  latestUserMessage?: { ts: string; userId: string } | null;
}

/**
 * The origin message: with `fork` the latest user message in the thread, else the message that triggered the turn
 * (falling back to the latest user message, e.g. for a results turn). Null when there is none.
 */
export function pickOrigin(o: OriginInput): { ts: string; authorId: string | null } | null {
  if (o.fork) return o.latestUserMessage ? { ts: o.latestUserMessage.ts, authorId: o.latestUserMessage.userId } : null;
  if (o.triggerTs) return { ts: o.triggerTs, authorId: o.latestUserMessage?.ts === o.triggerTs ? o.latestUserMessage.userId : null };
  return o.latestUserMessage ? { ts: o.latestUserMessage.ts, authorId: o.latestUserMessage.userId } : null;
}

/**
 * The create call's origin link and privacy. Slack refuses a DM as `origin_channel_id` (invalid_origin_link), and a
 * DM origin always makes a private channel anyway: no link then, and the requester is invited explicitly.
 * A channel is never less private than its source: anything but a known public channel (a private channel, a group
 * DM, a DM, or a conversation we couldn't look up) asks for `is_private` explicitly, so a missing origin link
 * doesn't leave the visibility to Slack's default.
 */
export function createOptions(o: { originIsDm: boolean; sourceIsPublic: boolean; private?: boolean; origin: { channelId: string; ts: string } | null }): {
  isPrivate?: true;
  origin?: { channelId: string; ts: string };
} {
  return {
    ...(o.originIsDm || !o.sourceIsPublic || o.private === true ? { isPrivate: true as const } : {}),
    ...(o.origin && !o.originIsDm ? { origin: o.origin } : {}),
  };
}

/** Most people one open_code_channel call (or one confirmation) invites. */
export const MAX_INVITES = 20;

/** `<@U…>`, `<@U…|name>` or a bare `U…` / `W…` id → the id; anything else null. */
export function parseUserId(raw: string): string | null {
  const m = /^\s*(?:<@)?([UW][A-Z0-9]+)(?:\|[^>]*)?>?\s*$/.exec(raw);
  return m ? m[1]! : null;
}

/**
 * Who of `members` is invited right away (members of the origin conversation) and who needs the requester's
 * confirmation (anyone else, and everyone when the origin is a DM: they'd see carried-over context). Ids are
 * deduplicated; `exclude` (the bot, people invited anyway) and unparseable entries are dropped; capped at MAX_INVITES.
 */
export function partitionInvites(o: { members: readonly string[]; originIsDm: boolean; isOriginMember: (id: string) => boolean; exclude: ReadonlySet<string> }): {
  direct: string[];
  confirm: string[];
  invalid: string[];
} {
  const direct: string[] = [];
  const confirm: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of o.members) {
    const id = parseUserId(raw);
    if (!id) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(id) || o.exclude.has(id)) continue;
    seen.add(id);
    if (seen.size > MAX_INVITES) break;
    (!o.originIsDm && o.isOriginMember(id) ? direct : confirm).push(id);
  }
  return { direct, confirm, invalid };
}

/** The fork seed (the channel's first message): "Forked from <link>" and the frozen summary. */
export function forkSeedText(o: { permalink?: string; summary: string | null }): string {
  const from = o.permalink ? `Forked from <${o.permalink}|this thread>` : 'Forked from a thread';
  return `${from}.\n\n${o.summary?.trim() || '_No summary: the thread had nothing to summarise yet._'}`;
}

/** Quote `text` as Slack mrkdwn (every line), cut to `max` characters. */
export function quoteText(text: string, max = 2500): string {
  const t = text.trim();
  const cut = t.length > max ? `${t.slice(0, max)}…` : t;
  return cut
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** The hand-off after a fork seed: the latest user message, quoted, so the channel answers it (a parent post). */
export function forkHandoffText(o: { authorId: string; text: string; permalink?: string }): string {
  const where = o.permalink ? ` in <${o.permalink}|the thread>` : '';
  return `<@${o.authorId}> wrote${where}:\n${quoteText(o.text || '(no text)')}`;
}

/** A brief as the channel's first message (a parent post: the channel runs a turn on it). */
export function briefText(o: { requesterId: string; brief: string; permalink?: string }): string {
  const where = o.permalink ? ` (from <${o.permalink}|this thread>)` : '';
  return `Brief from <@${o.requesterId}>${where}:\n${o.brief.trim()}`;
}

/** The one-line link left in the source thread after a fork. */
export function sourceLinkText(o: { channelId: string; seedPermalink?: string }): string {
  return o.seedPermalink ? `Continuing in <#${o.channelId}> → <${o.seedPermalink}|summary and next steps>` : `Continuing in <#${o.channelId}>.`;
}

/** The button area of the reply after a press moved the thread: "Moved → <link to the first message>". */
export function movedNote(o: { channelId: string; seedPermalink?: string }): string {
  return o.seedPermalink ? `Moved → <${o.seedPermalink}|code channel>` : `Moved → <#${o.channelId}>`;
}

/** The confirmation text for people who need the requester's go-ahead before they're invited. */
export function inviteConfirmText(o: { channelId: string; users: readonly string[] }): string {
  return `Invite ${o.users.map((u) => `<@${u}>`).join(', ')} to <#${o.channelId}>? They'll see what was carried over from this conversation.`;
}

/** The `value` of the invite confirmation buttons (≤ 2000 chars; MAX_INVITES ids fit easily). */
export interface InviteConfirmValue {
  /** The code channel. */
  c: string;
  /** Who to invite. */
  u: string[];
  /** Who may confirm (the requester). */
  r: string;
}

export function encodeInviteValue(v: InviteConfirmValue): string {
  return JSON.stringify(v);
}

export function decodeInviteValue(raw: string | undefined): InviteConfirmValue | null {
  try {
    const v = JSON.parse(raw ?? '') as Partial<InviteConfirmValue>;
    if (typeof v.c !== 'string' || !/^[CG][A-Z0-9]+$/.test(v.c) || typeof v.r !== 'string' || !Array.isArray(v.u)) return null;
    const users = v.u.filter((u): u is string => typeof u === 'string' && /^[UW][A-Z0-9]+$/.test(u)).slice(0, MAX_INVITES);
    return users.length ? { c: v.c, u: users, r: v.r } : null;
  } catch {
    return null;
  }
}

/** A channel reference from the model: `<#C…|name>`, `#C…` or a bare id → the id; null otherwise. */
export function parseChannelRef(raw: string): string | null {
  const m = /^\s*(?:<#|#)?([CG][A-Z0-9]+)(?:\|[^>]*)?>?\s*$/.exec(raw);
  return m ? m[1]! : null;
}

/** Does this look like a complete HTML document (Slack's HTML tabs must be)? */
export function isCompleteHtml(content: string): boolean {
  return /<html[\s>]/i.test(content) && /<\/html>\s*$/i.test(content.trim());
}

export const KIND_LABEL = { fork: 'forked from a thread', task: 'opened for a task', adopted: 'created in Slack and adopted by you' } as const;
