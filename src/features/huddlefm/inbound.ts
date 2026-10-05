/**
 * Messages from HuddleFM in the bot's DM with it (routed here by pipeline intake before anything else, so they are
 * never stored or treated as a person's DM): threaded command replies, grant answers and events.
 *
 * Runs in the slack-events processor, so it never waits on HuddleFM (the replies it would wait for come through this
 * same queue). Anything that needs a round trip is handed to the `huddlefm` queue (scheduleSync) or posted
 * fire-and-forget.
 */
import { env, limits } from '../../config.js';
import { redis } from '../../core/redis.js';
import { log } from '../../log.js';
import { scheduleSync, toppingUpKey } from './autodj.js';
import { sendCommand, storeReply } from './client.js';
import { deleteSessionTx } from './lifecycle.js';
import { announce } from './notices.js';
import { decodeMessage, isGrantType, trackLabel, type GrantType, type HfmMessage, type HfmTrack } from './protocol.js';
import { appendHistory, findByRequestTs, getSession, playbackFromStatus, touchEvent, type DjSession } from './store.js';

export interface HuddleFmMessageEvent {
  channel: string;
  channel_type?: string;
  user?: string;
  subtype?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

/** A message in the bot's DM with the HuddleFM user, from HuddleFM. */
export function isFromHuddleFm(ev: { user?: string; channel_type?: string; message?: { user?: string } }): boolean {
  const id = env.HUDDLEFM_USER_ID;
  return Boolean(id) && ev.channel_type === 'im' && (ev.user === id || ev.message?.user === id);
}

const abandonedKey = (requestTs: string) => `hfm:abandoned:${requestTs}`;

/** A pending request the user cancelled: if the host approves it later, the grant is released right away. */
export async function markAbandoned(requestTs: string, channelId: string): Promise<void> {
  await redis.set(abandonedKey(requestTs), channelId, 'EX', 60 * 60);
}

export async function handleHuddleFmMessage(ev: HuddleFmMessageEvent): Promise<void> {
  if (ev.subtype && ev.subtype !== 'bot_message') return; // edits, deletions, joins: nothing to act on
  const msg = decodeMessage(ev.text);
  if (!msg) return;
  if (msg.type === 'event') return handleEvent(msg, ev.ts);
  const replyTo = typeof msg.replyTo === 'string' ? msg.replyTo : ev.thread_ts;
  if (!replyTo) return;
  if (isGrantType(msg.type)) return handleGrant(msg.type, msg, replyTo);
  await storeReply(replyTo, msg);
}

/** The request's session row. Its request_ts is written right after the post returns: allow that a moment. */
async function sessionForRequest(requestTs: string): Promise<DjSession | null> {
  for (let i = 0; i < 6; i++) {
    const s = await findByRequestTs(requestTs);
    if (s) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function releaseUnwanted(channelId: string, requestTs: string): Promise<void> {
  // Fire-and-forget: the reply would come through this same queue.
  await sendCommand({ type: 'release_control', channel: channelId }, { idempotencyKey: `dj-release-unwanted:${requestTs}`, timeoutMs: 0 }).catch((err) =>
    log.warn({ err, channelId }, 'releasing an unwanted grant failed'),
  );
  log.info({ channelId, requestTs }, 'released an unwanted huddlefm grant');
}

const GRANT_TEXT: Record<Exclude<GrantType, 'grant_accepted'>, { what: (where: string) => string; fallback: (where: string) => string }> = {
  grant_declined: {
    what: (w) => `The huddle host declined your request to DJ in ${w}. DJ mode is off there.`,
    fallback: (w) => `the host said no to me djing in ${w}`,
  },
  grant_expired: {
    what: (w) => `Nobody approved your request to DJ in ${w} within 5 minutes, so it expired. DJ mode is off there.`,
    fallback: (w) => `nobody approved my dj request in ${w}, so it expired. ask again when the host is around`,
  },
  grant_revoked: {
    what: (w) => `The huddle host took DJ control away from you in ${w}. DJ mode is off there.`,
    fallback: (w) => `the host took me off the aux in ${w}`,
  },
};

async function handleGrant(type: GrantType, msg: HfmMessage, requestTs: string): Promise<void> {
  const abandonedChannel = await redis.get(abandonedKey(requestTs));
  const session = abandonedChannel ? null : await sessionForRequest(requestTs);
  if (!session) {
    const channelId = abandonedChannel ?? (typeof msg.channel === 'string' ? msg.channel : null);
    if (type === 'grant_accepted' && channelId) await releaseUnwanted(channelId, requestTs);
    return;
  }
  const where = `<#${session.channelId}>`;
  if (type !== 'grant_accepted') {
    const t = GRANT_TEXT[type];
    await announce({
      threadId: session.originThreadId,
      speakerId: session.requestedBy,
      ref: `${type}:${session.id}`,
      what: t.what(where),
      fallback: t.fallback(where),
      important: true,
      transition: (tx) => deleteSessionTx(tx, session, type === 'grant_revoked' ? undefined : 'pending'),
    });
    return;
  }

  const permissions = Array.isArray(msg.permissions) ? msg.permissions.map(String) : [];
  const playback = playbackFromStatus(msg);
  const settled = await announce({
    threadId: session.originThreadId,
    speakerId: session.requestedBy,
    ref: `grant_accepted:${session.id}`,
    what: [
      `The huddle host approved your request: you control the music in ${where} now (granted: ${permissions.join(', ') || 'unknown'}).`,
      session.autoDj
        ? `Auto DJ is on: you pick songs yourself and keep the queue going${session.vibe ? ` (vibe: ${session.vibe})` : ''}. People can turn it off if they'd rather pick.`
        : 'Auto DJ is off: you only play what people ask for.',
      session.chatter ? 'Chatter is on: you chime in now and then when a song starts.' : '',
      `Now playing: ${playback.nowPlaying ?? 'nothing'}.`,
    ]
      .filter(Boolean)
      .join(' '),
    how: 'Tell the thread in one short reply, in your own voice. If people in the thread already asked for specific songs, queue them now with huddle_dj. Then end your turn.',
    fallback: `the host let me on the aux in ${where}${session.autoDj ? ", i'll keep the queue going (tell me to stop auto dj if you want to pick)" : ''}`,
    important: true,
    transition: async (tx) =>
      (
        await tx`update dj_sessions set status = 'active', permissions = ${permissions}::text[], playback = ${tx.json(playback as any)},
                   granted_at = now(), last_event_at = now(), updated_at = now()
                 where id = ${session.id} and status = 'pending' returning id`
      ).length > 0,
  });
  if (settled) await scheduleSync(session.channelId, 'granted', 0);
}

async function handleEvent(msg: HfmMessage, eventTs: string): Promise<void> {
  const channelId = typeof msg.channel === 'string' ? msg.channel : null;
  const event = typeof msg.event === 'string' ? msg.event : null;
  if (!channelId || !event) return;
  const session = await getSession(channelId);
  if (session?.status !== 'active') return; // not ours (anymore)
  await touchEvent(channelId);
  const track = (msg.payload ?? {}) as HfmTrack & { reason?: string };
  const label = trackLabel(track);
  const ours = Boolean(label) && session.picks.includes(label);
  const where = `<#${channelId}>`;

  switch (event) {
    case 'session.ended':
    case 'session.suspended':
      await announce({
        threadId: session.originThreadId,
        speakerId: session.requestedBy,
        ref: `ended:${session.id}`,
        what: `The HuddleFM session in ${where} ${event === 'session.ended' ? 'ended' : 'was suspended'}, so DJ mode is over there.`,
        how: "Tell the thread in one short reply (if it was suspended, offer to ask the host again once it's back). Then end your turn.",
        fallback: `the huddlefm session in ${where} ended, so i'm off the aux`,
        important: true,
        transition: (tx) => deleteSessionTx(tx, session),
      });
      return;
    case 'track.started':
      if (label) await appendHistory(channelId, 'played', [label]);
      if (session.chatter && label) await chatter(session, label, ours, eventTs);
      break;
    case 'track.skipped':
      // The auto DJ's pick got skipped (by anyone, the bot included when someone asked it to): steer away from it.
      if (ours) await appendHistory(channelId, 'skipped', [label]);
      break;
    case 'queue.added':
      // Someone queued a song in HuddleFM directly: their taste. (Songs queued through the bot are recorded by the tool;
      // while a top-up runs, additions are the auto DJ's own.)
      if (label && !track.automatic && !ours && !(await redis.exists(toppingUpKey(channelId)))) await appendHistory(channelId, 'requested', [label]);
      break;
    case 'queue.removed':
      if (track.reason === 'failed' && label && !ours) await failedNotice(session, label, eventTs);
      break;
  }
  if (event.startsWith('track.') || event.startsWith('queue.')) await scheduleSync(channelId, event);
}

/** Chatter: one short line now and then when a song starts (cooldown in the transition: once per window, any worker). */
async function chatter(session: DjSession, label: string, ours: boolean, eventTs: string): Promise<void> {
  await announce({
    threadId: session.originThreadId,
    speakerId: session.requestedBy,
    ref: `chatter:${session.id}:${eventTs}`,
    what: `A new song just started in the huddle in <#${session.channelId}>: "${label}"${ours ? ' (your pick)' : ''}. Chatter is on.`,
    how: "Chime in with one short line about it like a radio DJ between songs (why it's a good one, a quick fact you're sure of, how it fits the vibe), in your own voice. If you have nothing good to say, stay silent. Don't call any other tool. Then end your turn.",
    fallback: null,
    important: false,
    transition: async (tx) =>
      (
        await tx`update dj_sessions set last_chatter_at = now()
                 where id = ${session.id} and status = 'active' and chatter
                   and (last_chatter_at is null or last_chatter_at < now() - ${limits.djChatterCooldownMs}::int * interval '1 millisecond')
                 returning id`
      ).length > 0,
  });
}

/** A song someone queued failed to download and HuddleFM dropped it: tell them (rate limited). */
async function failedNotice(session: DjSession, label: string, eventTs: string): Promise<void> {
  await announce({
    threadId: session.originThreadId,
    speakerId: session.requestedBy,
    ref: `failed:${session.id}:${eventTs}`,
    what: `"${label}" failed to download in the huddle in <#${session.channelId}>, so HuddleFM dropped it from the queue.`,
    how: 'Mention it in one short reply (offer to try another version). Then end your turn.',
    fallback: `"${label}" failed to download, so huddlefm dropped it from the queue`,
    important: false,
    transition: async (tx) =>
      (
        await tx`update dj_sessions set last_notice_at = now()
                 where id = ${session.id} and status = 'active'
                   and (last_notice_at is null or last_notice_at < now() - ${limits.djNoticeCooldownMs}::int * interval '1 millisecond')
                 returning id`
      ).length > 0,
  });
}
