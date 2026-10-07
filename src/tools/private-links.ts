/**
 * Which channel a linked Slack message may be read from, for read_public_thread / read_public_channel / ask_thread.
 *
 * Public channels: verified public via the cached conversations.info check slack_search uses; read with the USER
 * token (also channels the bot isn't in). Everything else fails closed, with ONE exception: a link into a PRIVATE
 * channel is read (with the BOT token) only when all of these hold:
 *   (a) the bot is a member of that channel;
 *   (b) the speaker is a member (conversations.members, cached briefly);
 *   (c) the current conversation is the speaker's DM with the bot, or that same private channel.
 * DMs and group DMs are never read through a link. A speaker who isn't a member gets exactly the refusal a missing
 * or unknown channel gets, so nothing reveals that a private channel exists, what it's called, or what's in it.
 */
import { getConversationInfo, isChannelMember, type ConversationInfo } from '../context/conversation.js';
import { publicChannelNames } from './slack-search.js';

export type LinkTarget = 'thread' | 'channel';

/** The linked conversation as the bot sees it (conversations.info, bot token); null when the bot can't see it. */
export type LinkedConversation = Pick<ConversationInfo, 'id' | 'kind' | 'isMember'> | null;

export interface PrivateLinkInput {
  link: LinkedConversation;
  /** Speaker (or subagent owner) is a member of the linked channel. */
  speakerIsMember: boolean;
  speakerId: string;
  /** Where the request is made; kind/imUserId from conversations.info (missing when the lookup failed). */
  current: { id: string; kind?: ConversationInfo['kind']; imUserId?: string };
}

export type PrivateLinkDecision =
  | { ok: true; via: 'dm' | 'same_channel' }
  /** not_visible: same answer for "doesn't exist", "bot isn't in it" and "you aren't in it" (no leak). */
  | { ok: false; reason: 'not_visible' | 'ask_in_dm' };

/**
 * Pure decision for a link that did NOT verify as public. Order matters: everything that would tell a non-member
 * something (exists, bot is in it, it's private) collapses into `not_visible` before the conversation is considered.
 */
export function decidePrivateLink(i: PrivateLinkInput): PrivateLinkDecision {
  const { link } = i;
  if (!link || link.kind !== 'private_channel') return { ok: false, reason: 'not_visible' }; // DMs, group DMs, unknown
  if (!link.isMember) return { ok: false, reason: 'not_visible' }; // (a)
  if (!i.speakerIsMember) return { ok: false, reason: 'not_visible' }; // (b)
  if (i.current.id === link.id) return { ok: true, via: 'same_channel' }; // (c) the linked channel itself
  if (i.current.kind === 'dm' && i.current.imUserId === i.speakerId) return { ok: true, via: 'dm' }; // (c) 1:1 DM
  return { ok: false, reason: 'ask_in_dm' };
}

export const notVisibleMessage = (what: LinkTarget) =>
  `Can't read that ${what}: it isn't in a public channel (or couldn't be verified as one), and it isn't a private channel that both the person asking and I are in. Say you can't see it; don't guess what it is.`;

export const askInDmMessage = (what: LinkTarget) =>
  `Can't read that ${what} here: it's in a private channel. I can read private-channel links only when someone in that channel asks me in a DM (or in that channel itself). Tell them to ask in a DM with me; don't name the channel or guess what's in it.`;

export interface LinkAccess {
  visibility: 'public' | 'private';
  /** Public: user token (channels:history, any public channel). Private: bot token (only channels it's in). */
  token: 'user' | 'bot';
  /** `<#C…|name>` (name only when known). */
  chLabel: string;
}

const label = (id: string, name?: string) => (name ? `<#${id}|${name}>` : `<#${id}>`);

/**
 * Access check for reading `channel` through a link, on behalf of `who.speakerId` in conversation `who.channelId`.
 * Public first (same cached check as slack_search); otherwise the private-link rule. Returns the token to read with,
 * or a model-facing refusal. Never throws (lookups fail closed).
 */
export async function resolveLinkAccess(channel: string, who: { speakerId: string; channelId?: string }, what: LinkTarget): Promise<LinkAccess | { error: string }> {
  // DMs (D…) are never read through a link; only C… / G… ids can be channels. G… (legacy private channels and
  // group DMs) never counts as public, as before: it can only pass the private-link rule.
  if (!/^[CG]/.test(channel)) return { error: notVisibleMessage(what) };
  if (channel.startsWith('C')) {
    const pub = await publicChannelNames([channel]);
    if (pub.has(channel)) return { visibility: 'public', token: 'user', chLabel: label(channel, pub.get(channel) || undefined) };
  }
  if (!who.channelId) return { error: notVisibleMessage(what) };

  const info = await getConversationInfo(channel).catch(() => null);
  const link: LinkedConversation = info ? { id: info.id, kind: info.kind, isMember: info.isMember } : null;
  // Only look up the speaker when (a) holds: no membership calls for channels the bot can't read anyway.
  const candidate = !!link && link.kind === 'private_channel' && link.isMember;
  const speakerIsMember = candidate ? await isChannelMember(channel, who.speakerId).catch(() => false) : false;
  let current: PrivateLinkInput['current'] = { id: who.channelId };
  if (candidate && speakerIsMember && who.channelId !== channel) {
    const cur = await getConversationInfo(who.channelId).catch(() => null);
    if (cur) current = { id: who.channelId, kind: cur.kind, ...(cur.imUserId ? { imUserId: cur.imUserId } : {}) };
  }
  const d = decidePrivateLink({ link, speakerIsMember, speakerId: who.speakerId, current });
  if (!d.ok) return { error: d.reason === 'ask_in_dm' ? askInDmMessage(what) : notVisibleMessage(what) };
  return { visibility: 'private', token: 'bot', chLabel: label(channel, info?.name) };
}
