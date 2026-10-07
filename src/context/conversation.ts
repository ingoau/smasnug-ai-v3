// OWNER: tools/context module.
/**
 * The conversation a turn happens in (conversations.info, bot token, cached in Redis): name, type, topic, purpose,
 * member count and whether people from another org are in it. Rendered as the turn message's <conversation>
 * section (stable per thread, so it goes first). Also the membership checks for reading private-channel links
 * (src/tools/private-links.ts). Topic and purpose are user-written: one line each, capped, no angle brackets.
 */
import { redis } from '../core/redis.js';
import { slackCall, slackErrorCode } from '../core/slack.js';
import { log } from '../log.js';
import { profileText } from './people.js';

export type ConversationKind = 'public_channel' | 'private_channel' | 'dm' | 'group_dm';

export interface ConversationInfo {
  id: string;
  name?: string;
  kind: ConversationKind;
  /** Slack Connect: shared with another organisation (external members present). */
  isExtShared: boolean;
  /** The bot is a member (conversations.info `is_member`; DMs with the bot always). */
  isMember: boolean;
  topic?: string;
  purpose?: string;
  numMembers?: number;
  /** DMs: the other party. */
  imUserId?: string;
  isArchived?: boolean;
}

/** Topic / purpose length in the prompt. */
export const CONVERSATION_FIELD_MAX = 160;
const TTL_S = 10 * 60;
const NEG_TTL_S = 2 * 60;
const key = (id: string) => `slack:conv:v1:${id}`;

/** Pure: conversations.info `channel` → ConversationInfo, or null when it isn't one. */
export function conversationInfoFromSlack(ch: any): ConversationInfo | null {
  if (!ch || typeof ch.id !== 'string') return null;
  const kind: ConversationKind = ch.is_im ? 'dm' : ch.is_mpim ? 'group_dm' : ch.is_private === false && !ch.is_group ? 'public_channel' : 'private_channel';
  const text = (v: any) => (typeof v?.value === 'string' && v.value.trim() ? v.value : undefined);
  return {
    id: ch.id,
    ...(typeof ch.name === 'string' && ch.name && kind !== 'dm' ? { name: ch.name } : {}),
    kind,
    isExtShared: Boolean(ch.is_ext_shared || ch.is_pending_ext_shared),
    isMember: kind === 'dm' ? true : Boolean(ch.is_member),
    ...(text(ch.topic) ? { topic: text(ch.topic) } : {}),
    ...(text(ch.purpose) ? { purpose: text(ch.purpose) } : {}),
    ...(typeof ch.num_members === 'number' ? { numMembers: ch.num_members } : {}),
    ...(kind === 'dm' && typeof ch.user === 'string' ? { imUserId: ch.user } : {}),
    ...(ch.is_archived ? { isArchived: true } : {}),
  };
}

/**
 * conversations.info (bot token, with the member count), cached ~10 min. Null when the bot can't see it (cached
 * briefly) or the lookup fails (not cached).
 */
export async function getConversationInfo(channelId: string): Promise<ConversationInfo | null> {
  const cached = await redis.get(key(channelId)).catch(() => null);
  if (cached) return cached === 'null' ? null : (JSON.parse(cached) as ConversationInfo);
  try {
    const res = await slackCall<any>('conversations.info', { channel: channelId, include_num_members: true });
    const info = res?.ok === false ? null : conversationInfoFromSlack(res?.channel);
    if (info && info.id !== channelId) return null;
    await redis.set(key(channelId), info ? JSON.stringify(info) : 'null', 'EX', info ? TTL_S : NEG_TTL_S).catch(() => {});
    return info;
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === 'channel_not_found' || code === 'method_not_supported_for_channel_type') {
      await redis.set(key(channelId), 'null', 'EX', NEG_TTL_S).catch(() => {});
      return null;
    }
    log.warn({ err, channelId }, 'conversations.info failed');
    return null;
  }
}

/** The conversation's type in words for the model. */
export function conversationTypeLabel(c: Pick<ConversationInfo, 'kind' | 'isExtShared'>): string {
  const base =
    c.kind === 'public_channel'
      ? 'public channel'
      : c.kind === 'private_channel'
        ? 'private channel'
        : c.kind === 'group_dm'
          ? 'group DM'
          : 'DM with you (Slack agent container: each thread is its own conversation)';
  return c.isExtShared ? `${base}, Slack Connect (shared with another org)` : base;
}

/**
 * The <conversation> body, e.g.
 *   <#C123|hardware>: public channel, 1234 members, no external members
 *   Topic: soldering help
 *   Purpose: ask hardware questions
 */
export function renderConversation(c: ConversationInfo): string {
  const where = c.kind === 'dm' ? (c.imUserId ? `DM with <@${c.imUserId}>` : 'DM') : c.name ? `<#${c.id}|${profileText(c.name, 80)}>` : `<#${c.id}>`;
  const facts = [conversationTypeLabel(c)];
  if (c.kind !== 'dm' && c.numMembers !== undefined) facts.push(`${c.numMembers} ${c.numMembers === 1 ? 'member' : 'members'}`);
  if (c.kind !== 'dm') facts.push(c.isExtShared ? 'people from another org are in it' : 'no external members');
  if (c.isArchived) facts.push('archived');
  const lines = [`${where}: ${facts.join(', ')}`];
  const topic = profileText(c.topic, CONVERSATION_FIELD_MAX);
  const purpose = profileText(c.purpose, CONVERSATION_FIELD_MAX);
  if (topic) lines.push(`Topic: ${topic}`);
  if (purpose && purpose !== topic) lines.push(`Purpose: ${purpose}`);
  return lines.join('\n');
}

const membersKey = (channelId: string) => `slack:members:v1:${channelId}`;
const MEMBERS_TTL_S = 2 * 60;
/** Bigger channels aren't cached as a whole (private channels are usually small). */
const MAX_MEMBERS_CACHED = 5000;

/**
 * Is `userId` a member of `channelId` (conversations.members, bot token, paged; cached ~2 min)? Fails closed: any
 * error means "no".
 */
export async function isChannelMember(channelId: string, userId: string): Promise<boolean> {
  try {
    const cached = await redis.get(membersKey(channelId)).catch(() => null);
    if (cached) return (JSON.parse(cached) as string[]).includes(userId);
    const members: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await slackCall<any>('conversations.members', { channel: channelId, limit: 1000, ...(cursor ? { cursor } : {}) });
      members.push(...((res?.members as string[]) ?? []));
      cursor = res?.response_metadata?.next_cursor || undefined;
    } while (cursor && members.length < 20_000);
    if (members.length <= MAX_MEMBERS_CACHED) await redis.set(membersKey(channelId), JSON.stringify(members), 'EX', MEMBERS_TTL_S).catch(() => {});
    return members.includes(userId);
  } catch (err) {
    log.warn({ err, channelId }, 'conversations.members failed; treating as not a member');
    return false;
  }
}
