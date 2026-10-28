/** What the front agent knows about DJ mode: the per-turn <huddle_dj> section (the instructions are the huddle-dj skill). */
import { log } from '../../log.js';
import { huddleFmConfigured } from './client.js';
import { sessionsForTurn, type DjSession } from './store.js';

/** `detail`: now playing and up next. Only for the huddle's own channel or its requester's DM (private channels). */
export function renderSession(s: DjSession, here: { channelId: string }, detail = true): string {
  const where = `<#${s.channelId}>${s.channelId === here.channelId ? ' (this channel)' : ''}`;
  if (s.status === 'pending') return `- ${where}: you asked to DJ (asked by <@${s.requestedBy}>), waiting for the huddle host to approve.`;
  const lines = [
    `- ${where}: you're the DJ (HuddleFM). auto DJ ${s.autoDj ? `on${s.vibe ? `, vibe "${s.vibe}"` : ''}` : 'off'}, chatter ${s.chatter ? 'on' : 'off'}.`,
  ];
  const p = detail ? s.playback : null;
  if (p) {
    lines.push(`  now playing: ${p.nowPlaying ?? 'nothing'}`);
    if (p.queue.length) {
      lines.push('  up next:', ...p.queue.map((t, i) => `    ${i + 1}. ${t}`));
      if (p.queueLength > p.queue.length) lines.push(`    …and ${p.queueLength - p.queue.length} more`);
    } else lines.push('  up next: nothing queued');
  }
  return lines.join('\n');
}

/** The per-turn <huddle_dj> section body ('' when there's nothing to say). */
export async function renderDjState(opts: { channelId: string; threadId: string; speakerId: string }): Promise<string> {
  if (!huddleFmConfigured()) return '';
  try {
    const sessions = await sessionsForTurn(opts);
    if (!sessions.length) return '';
    return [
      ...sessions.map((s) => renderSession(s, opts, s.channelId === opts.channelId || (opts.channelId.startsWith('D') && s.requestedBy === opts.speakerId))),
      // Inline while a session exists, so a "skip this" doesn't need a load_skill step first; setup is the huddle-dj skill.
      'Messages about the music in these huddles (skip this, turn it up, play X) are aimed at you. Music requests go through huddle_dj: pick real songs with good taste (at most 5 per ask unless told otherwise), empty the queue only when someone asks. "let us pick" / "stop picking", "play more X", "stop commenting" → huddle_dj_settings; "stop being the dj" → huddle_dj_mode off (you can never end the HuddleFM session). Reply briefly with what you did; if a command says the grant is gone, DJ mode is off: say so and offer to ask the host again. Never DM HuddleFM or paste its JSON.',
    ].join('\n');
  } catch (err) {
    log.warn({ err }, 'renderDjState failed');
    return '';
  }
}

/** For the relevance gate: a note when the bot is DJing in this thread's channel, or was asked to from this thread. */
export async function djGateNote(opts: { channelId: string; threadId: string }): Promise<string | undefined> {
  if (!huddleFmConfigured()) return undefined;
  try {
    const sessions = await sessionsForTurn({ ...opts, speakerId: '' });
    if (!sessions.some((s) => s.status === 'active')) return undefined;
    return 'The bot is currently the DJ for the huddle music here (HuddleFM). Requests about the music (skip this, play X, turn it down/up, what song is this, pause) are addressed to it.';
  } catch {
    return undefined;
  }
}
