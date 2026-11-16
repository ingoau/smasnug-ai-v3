/**
 * Adoption (docs/code-channels.md, Opening one): a code channel created from Slack's own UI is recorded the first
 * time the bot is mentioned there. Recognised by conversations.info (`getConversationInfo`, cached in Redis, which
 * also caches the negative answer for ordinary channels). Callers check `codeChannelsEnabled()` first.
 *
 * An adopted channel with an origin link is "treated as a fork of that message's thread": its seed summary is
 * written on its first turn (seed.ts ensureAdoptedSeed, from turn-context.ts). TODO(stage 4): register its slash
 * commands here.
 */
import { appendEvent, codeChannelThreadId, threadIdOf } from '../../core/events.js';
import { getConversationInfo } from '../../context/conversation.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { deriveSessionId } from './ids.js';
import { createCodeChannelRow, type CodeChannel } from './store.js';

/** The thread we know the origin message by: its own stored thread, or the thread it roots. Null if we never saw it. */
async function originThreadId(o: { channelId: string; ts: string }): Promise<string | null> {
  const [m] = await sql<{ threadId: string | null }[]>`select thread_id from messages where channel_id = ${o.channelId} and ts = ${o.ts} and thread_id is not null`;
  if (m?.threadId) return m.threadId;
  const id = threadIdOf(o.channelId, o.ts);
  const [t] = await sql<{ id: string }[]>`select id from threads where id = ${id}`;
  return t ? id : null;
}

/**
 * Record `channelId` as an adopted code channel if Slack says it is an agent channel. Returns the row, or null for
 * an ordinary channel (or when the lookup fails: tried again on a later mention).
 */
export async function adoptIfAgentChannel(channelId: string, requesterId: string | undefined): Promise<CodeChannel | null> {
  const info = await getConversationInfo(channelId);
  if (!info?.agentChannel || info.kind === 'dm' || info.kind === 'group_dm') return null;
  const origin = info.agentChannel.originLink ?? null;
  const parentThreadId = origin ? await originThreadId(origin).catch(() => null) : null;
  const { row, created } = await createCodeChannelRow({
    channelId,
    sessionId: deriveSessionId({ via: 'adopt', channelId }),
    kind: 'adopted',
    name: info.name ?? channelId,
    parentThreadId,
    origin,
    requesterId: requesterId ?? null,
    isPrivate: info.kind === 'private_channel',
  });
  if (created) {
    await appendEvent(codeChannelThreadId(channelId), 'code_channel_adopted', requesterId ?? null, { origin, parentThreadId });
    log.info({ channelId, origin, parentThreadId }, 'code channel adopted');
  }
  return row;
}
