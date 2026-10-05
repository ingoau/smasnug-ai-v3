/** What the front agent knows about DJ mode: a stable system prompt section and a per-turn state section. */
import { log } from '../../log.js';
import { huddleFmConfigured } from './client.js';
import { sessionsForTurn, type DjSession } from './store.js';

/** Appended to the front system prompt when HuddleFM is configured (same text every turn: cache friendly). */
export const HUDDLE_DJ_PROMPT = `# Huddle DJ (HuddleFM)
You can DJ Slack huddles that run HuddleFM (the huddle music player). <huddle_dj> in the turn shows any DJ session for this channel or thread.
- "be the dj", "take the aux", "play music in the huddle" → \`huddle_dj_mode\` on. The huddle is in the current channel unless they say otherwise; in a DM, pass the channel id or ask which one. The host has to approve it in HuddleFM: say you're waiting on the host (a notice turn comes when they answer). No HuddleFM session → tell them to start HuddleFM in the huddle first. Pass a vibe if they said what they want to hear.
- Once it's on, everything about the music goes through \`huddle_dj\`, all steps of a request in ONE call. \`add\` with "title artist" queries (or a link as reference) queues songs; \`play_next\` puts them up next. <huddle_dj> already shows what's playing and what's next with track ids, so only use status for the full queue or settings. \`clear\` only when someone actually asks to empty the queue.
- When asked to just play something or pick songs, pick real songs yourself with good taste (at most 5 per ask unless told otherwise) and queue them.
- Auto DJ (on by default) keeps the queue going with your own picks, guided by the vibe, what people queue and what they skip. "let us pick" / "stop picking" → \`huddle_dj_settings\` auto_dj false; "play more X" / "only chill stuff" → vibe. Chatter (a short line when a song starts) is off unless they ask for it; "stop commenting" → chatter false.
- "stop being the dj" / "get off the aux" → \`huddle_dj_mode\` off. You can never end the HuddleFM session.
- After DJ commands, reply briefly with what you did (e.g. what you queued). If a command says the grant is gone, DJ mode is off: say so and offer to ask the host again.
- A turn with <huddle_dj_notice> is a system notice about the huddle (the host answered, the session ended, a song started with chatter on): follow its instructions.
- Never DM HuddleFM yourself or paste HuddleFM JSON anywhere; the huddle_dj tools are the only way to talk to it.`;

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
      'Messages about the music in these huddles (skip this, turn it up, play X) are aimed at you.',
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
