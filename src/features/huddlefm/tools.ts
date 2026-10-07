/**
 * Front-agent tools for HuddleFM DJ mode (registered only when HUDDLEFM_USER_ID is set):
 * - huddle_dj_mode: ask the huddle host to let the bot control the music (or stop / cancel).
 * - huddle_dj: run music commands in order (queue songs, skip, pause, volume, edit the queue…).
 * - huddle_dj_settings: auto DJ on/off, the vibe it picks for, chatter on/off.
 *
 * Anyone in the huddle's channel can use them (the host approved the bot, not a person). Controlling a channel other
 * than the current one needs the speaker to be a member of it.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { limits } from '../../config.js';
import { redis } from '../../core/redis.js';
import { slackCall } from '../../core/slack.js';
import type { ToolContext } from '../../core/tools.js';
import { log } from '../../log.js';
import { takeLimit } from '../guard.js';
import { clearBackoff, scheduleSync } from './autodj.js';
import { sendCommand } from './client.js';
import { markAbandoned, rememberRequest } from './inbound.js';
import { deleteSession } from './lifecycle.js';
import { pickResult, type SearchResult } from './match.js';
import { LOST_GRANT_ERRORS, parseChannelArg, REQUESTED_EVENTS, REQUESTED_PERMISSIONS, replyError, trackLabel, type HfmMessage, type HfmTrack } from './protocol.js';
import { appendHistory, createPending, getSession, playbackFromStatus, savePlayback, setRequestTs, updateSettings, type DjSession } from './store.js';

// ---------- channel + membership ----------

const memberKey = (channelId: string, userId: string) => `hfm:member:${channelId}:${userId}`;

/** Whether the user is in the channel (conversations.members, cached briefly). Fails closed. */
async function isMember(userId: string, channelId: string): Promise<boolean> {
  const cached = await redis.get(memberKey(channelId, userId));
  if (cached) return cached === '1';
  let member = false;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20 && !member; page++) {
      const res = await slackCall<any>('conversations.members', { channel: channelId, limit: 1000, ...(cursor ? { cursor } : {}) });
      member = (res.members as string[] | undefined)?.includes(userId) ?? false;
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (err) {
    log.warn({ err, channelId }, 'huddle dj: membership check failed');
  }
  await redis.set(memberKey(channelId, userId), member ? '1' : '0', 'EX', member ? 600 : 60);
  return member;
}

type Resolved = { channelId: string } | { error: string };

export async function resolveChannel(ctx: Pick<ToolContext, 'channelId' | 'speakerId'>, raw: string | undefined): Promise<Resolved> {
  const explicit = parseChannelArg(raw);
  if (raw?.trim() && !explicit) return { error: `"${raw}" is not a channel id. Pass the huddle's channel id (like C0123ABC, from <#C0123ABC|name>).` };
  const channelId = explicit ?? (ctx.channelId.startsWith('D') ? null : ctx.channelId);
  if (!channelId) return { error: "This is a DM: pass the channel the huddle is in as `channel` (ask which one if it isn't clear)." };
  if (channelId !== ctx.channelId && !(await isMember(ctx.speakerId, channelId)))
    return { error: "The speaker isn't a member of that channel, so you can't control its huddle for them." };
  return { channelId };
}

const toolCallId = (options: unknown) => String((options as { toolCallId?: string })?.toolCallId ?? Date.now());
const json = (o: unknown) => JSON.stringify(o);

// ---------- huddle_dj_mode ----------

export async function djMode(
  ctx: ToolContext,
  input: { enabled: boolean; channel?: string; auto_dj?: boolean; chatter?: boolean; vibe?: string },
  callId: string,
): Promise<string> {
  const resolved = await resolveChannel(ctx, input.channel);
  if ('error' in resolved) return resolved.error;
  const { channelId } = resolved;
  const where = `<#${channelId}>`;
  const existing = await getSession(channelId);

  if (!input.enabled) {
    if (!existing) return `DJ mode isn't on in ${where}.`;
    await deleteSession(existing);
    if (existing.status === 'pending') {
      if (existing.requestTs) await markAbandoned(existing.requestTs, channelId);
      return `Cancelled the DJ request for ${where}. If the host approves it anyway, control is released right away.`;
    }
    const { reply } = await sendCommand({ type: 'release_control', channel: channelId }, { idempotencyKey: `dj-release:${existing.id}`, timeoutMs: 5_000 }).catch(
      (err) => (log.warn({ err, channelId }, 'release_control failed'), { reply: null }),
    );
    return reply?.ok === false && !LOST_GRANT_ERRORS.has(reply.error ?? '')
      ? `DJ mode is off in ${where} (HuddleFM said ${replyError(reply)} when releasing control).`
      : `DJ mode is off in ${where}, control released.`;
  }

  if (existing?.status === 'active') return `DJ mode is already on in ${where}. Use huddle_dj for the music and huddle_dj_settings to change auto DJ / vibe / chatter.`;
  if (existing?.status === 'pending')
    return `Already waiting for the huddle host to approve DJ mode in ${where}. A notice turn comes in this thread when they answer; tell them you're waiting on the host.`;
  const limited = await takeLimit('dj', ctx.speakerId, ctx.threadId);
  if (limited) return limited;

  const session = await createPending({
    channelId,
    requestedBy: ctx.speakerId,
    originThreadId: ctx.threadId,
    autoDj: input.auto_dj ?? true,
    chatter: input.chatter ?? false,
    vibe: input.vibe?.trim().slice(0, 300) || null,
  });
  let reply: HfmMessage | null;
  try {
    ({ reply } = await sendCommand(
      { type: 'request_control', channel: channelId, permissions: [...REQUESTED_PERMISSIONS], events: [...REQUESTED_EVENTS] },
      { idempotencyKey: `dj-request:${session.id}:${callId}`, timeoutMs: limits.djRequestGraceMs, onSent: async (ts) => (await rememberRequest(ts, channelId), await setRequestTs(session.id, ts)) },
    ));
  } catch (err) {
    await deleteSession(session);
    throw err;
  }
  // A valid request gets no immediate answer: silence means it's waiting on the host. Failures answer right away.
  if (reply && reply.ok === false) {
    await deleteSession(session);
    if (reply.error === 'session_not_found') return `There's no HuddleFM session in ${where}. Someone has to start HuddleFM in the huddle first.`;
    return `HuddleFM refused the request: ${replyError(reply)}.`;
  }
  return (
    `Request sent: the huddle host has to approve it in HuddleFM (it expires after 5 minutes). Auto DJ will be ${session.autoDj ? 'on' : 'off'}${session.vibe ? ` (vibe: ${session.vibe})` : ''}, chatter ${session.chatter ? 'on' : 'off'}. ` +
    "You get a notice turn in this thread when the host answers, so just say you're waiting on the host. Don't promise anything else."
  );
}

// ---------- huddle_dj ----------

const COMMANDS = ['status', 'search', 'add', 'remove', 'move', 'shuffle', 'clear', 'skip', 'previous', 'pause', 'resume', 'seek', 'volume'] as const;
const READ_ONLY = new Set(['status', 'search']);

export const StepSchema = z.object({
  command: z
    .enum(COMMANDS)
    .describe(
      'status: now playing, the full queue and settings. search: find songs. add: queue songs. remove / move: edit the queue by track_id. ' +
        'skip (count = several), previous, pause, resume, seek (relative seconds), volume (0-100), shuffle, clear (empties the whole queue; only when asked).',
    ),
  query: z.string().optional().describe('search / add: "song title artist". add with a query queues the best matching search result.'),
  queries: z.array(z.string()).min(1).max(limits.djMaxBatch).optional().describe('search / add: several "song title artist" queries at once instead of query, in order.'),
  reference: z.string().optional().describe('add: a reference from search results, or a media URL (YouTube, Spotify…, album or playlist links too).'),
  play_next: z.boolean().optional().describe('add: move the added songs to play next (in order) instead of the end of the queue.'),
  track_id: z.string().optional().describe('remove / move: the trackId shown in <huddle_dj> or status.'),
  direction: z.enum(['up', 'down']).optional().describe('move: one spot up or down'),
  position: z.number().int().min(1).optional().describe('move: 1-based queue position'),
  count: z.number().int().min(1).max(limits.djMaxSkip).optional().describe('skip: how many songs, default 1'),
  seconds: z.number().optional().describe('seek: relative seconds, negative goes back'),
  percent: z.number().min(0).max(100).optional().describe('volume: 0-100'),
});
export type Step = z.infer<typeof StepSchema>;

interface StepResult {
  command: string;
  ok: boolean;
  /** The grant is gone: stop, DJ mode ended. */
  lost?: boolean;
  /** HuddleFM didn't answer in time: stop the whole call instead of waiting again for every remaining command. */
  unreachable?: boolean;
  [k: string]: unknown;
}

/** Strip transport fields from a reply for the model. */
function data(reply: HfmMessage): Record<string, unknown> {
  const { v: _v, replyTo: _r, ok: _o, type: _t, ...rest } = reply;
  return rest;
}

function failure(command: string, reply: HfmMessage | null): StepResult {
  if (!reply) return { command, ok: false, unreachable: true, error: "HuddleFM didn't answer in time; it may be down or restarting. Stopped here, nothing after this ran." };
  const lost = LOST_GRANT_ERRORS.has(reply?.error ?? '');
  return { command, ok: false, ...(lost ? { lost } : {}), error: lost ? `${reply!.error}: the grant is gone, DJ mode is off now` : replyError(reply) };
}

/** Status for the model: compact queue with track ids. */
function statusView(reply: HfmMessage) {
  const queue = Array.isArray(reply.queue) ? (reply.queue as HfmTrack[]) : [];
  const { queue: _q, nowPlaying: _n, ...settings } = data(reply);
  return {
    nowPlaying: trackLabel(reply.nowPlaying as HfmTrack | null) || null,
    queue: queue.slice(0, 25).map((t, i) => `${i + 1}. ${trackLabel(t)} [trackId ${t.id}]${t.automatic ? ' (autoplay)' : ''}`),
    queueLength: queue.length,
    ...settings,
  };
}

export async function runStep(session: DjSession, step: Step, keyBase: string): Promise<StepResult> {
  const channel = session.channelId;
  const send = (cmd: Record<string, unknown> & { type: string }, n = 0) =>
    sendCommand({ ...cmd, channel }, READ_ONLY.has(cmd.type) ? {} : { idempotencyKey: `${keyBase}:${cmd.type}:${n}` }).then((r) => r.reply);
  const { command } = step;

  switch (command) {
    case 'status': {
      const reply = await send({ type: 'status' });
      if (!reply?.ok) return failure(command, reply);
      await savePlayback(channel, playbackFromStatus(reply));
      return { command, ok: true, ...statusView(reply) };
    }
    case 'search': {
      const queries = step.queries ?? (step.query ? [step.query] : []);
      if (!queries.length) return { command, ok: false, error: 'search needs query or queries' };
      const results: unknown[] = [];
      for (const q of queries) {
        const reply = await send({ type: 'search', query: q });
        if (!reply?.ok) {
          const f = failure(command, reply);
          if (f.lost || f.unreachable) return f;
          results.push({ query: q, error: f.error });
          continue;
        }
        results.push({ query: q, results: ((reply.results as SearchResult[] | undefined) ?? []).slice(0, 5) });
      }
      return { command, ok: true, results };
    }
    case 'add':
      return addSongs(session, step, send);
    case 'skip': {
      const skipped: string[] = [];
      let last: HfmMessage | null = null;
      for (let i = 0; i < (step.count ?? 1); i++) {
        last = await send({ type: 'skip' }, i);
        if (!last?.ok) break;
        skipped.push(trackLabel(last.skipped as HfmTrack));
      }
      if (!skipped.length) return failure(command, last);
      return {
        command,
        ok: true,
        skipped,
        nowPlaying: last?.ok ? trackLabel(last.nowPlaying as HfmTrack) || null : undefined,
        ...(skipped.length < (step.count ?? 1) ? { stoppedEarly: replyError(last) } : {}),
        ...(last === null ? { unreachable: true } : {}),
      };
    }
    case 'remove':
    case 'move': {
      if (!step.track_id) return { command, ok: false, error: `${command} needs track_id` };
      const cmd: Record<string, unknown> & { type: string } = { type: command, trackId: step.track_id };
      if (command === 'move') {
        if (step.position) cmd.position = step.position;
        else if (step.direction) cmd.direction = step.direction;
        else cmd.playNext = true;
      }
      const reply = await send(cmd);
      return reply?.ok ? { command, ok: true, ...data(reply) } : failure(command, reply);
    }
    case 'seek': {
      if (step.seconds == null) return { command, ok: false, error: 'seek needs seconds' };
      const reply = await send({ type: 'seek', seconds: step.seconds });
      return reply?.ok ? { command, ok: true, ...data(reply) } : failure(command, reply);
    }
    case 'volume': {
      if (step.percent == null) return { command, ok: false, error: 'volume needs percent' };
      const reply = await send({ type: 'volume', percent: Math.round(step.percent) });
      return reply?.ok ? { command, ok: true, ...data(reply) } : failure(command, reply);
    }
    default: {
      // shuffle, clear, previous, pause, resume
      const reply = await send({ type: command });
      return reply?.ok ? { command, ok: true, ...data(reply) } : failure(command, reply);
    }
  }
}

async function addSongs(
  session: DjSession,
  step: Step,
  send: (cmd: Record<string, unknown> & { type: string }, n?: number) => Promise<HfmMessage | null>,
): Promise<StepResult> {
  const items: ({ reference: string } | { query: string })[] = step.reference
    ? [{ reference: step.reference }]
    : (step.queries ?? (step.query ? [step.query] : [])).map((query) => ({ query }));
  if (!items.length) return { command: 'add', ok: false, error: 'add needs query, queries or reference' };
  const results: unknown[] = [];
  const addedIds: string[] = [];
  const addedLabels: string[] = [];
  let n = 0;
  /** Lost grant / no answer: stop, but still report (and remember) what was added before. */
  let stop: StepResult | null = null;
  for (const item of items) {
    let reference: string;
    if ('query' in item) {
      const search = await send({ type: 'search', query: item.query });
      if (!search?.ok) {
        const f = failure('add', search);
        if (f.lost || f.unreachable) {
          stop = f;
          break;
        }
        results.push({ query: item.query, error: f.error });
        continue;
      }
      const pick = pickResult({ title: item.query }, (search.results as SearchResult[] | undefined) ?? [], { strict: false });
      if (!pick) {
        results.push({ query: item.query, error: 'no search results' });
        continue;
      }
      reference = pick.reference;
    } else reference = item.reference;
    const reply = await send({ type: 'add', reference }, n++);
    if (!reply?.ok) {
      const f = failure('add', reply);
      if (f.lost || f.unreachable) {
        stop = f;
        break;
      }
      results.push({ ...item, error: f.error });
      if (reply?.error === 'queue_full') break;
      continue;
    }
    const added = (reply.added as HfmTrack[] | undefined) ?? [];
    addedIds.push(...added.map((t) => t.id).filter((id): id is string => Boolean(id)));
    addedLabels.push(...added.map(trackLabel).filter(Boolean));
    results.push({ ...item, added: added.map(trackLabel), ...(reply.omitted ? { omitted: reply.omitted } : {}) });
  }
  // People asked for these: the auto DJ's best signal of taste.
  await appendHistory(session.channelId, 'requested', addedLabels.slice(0, limits.djMaxBatch));
  if (stop) return { ...stop, ok: addedLabels.length > 0, results };
  if (step.play_next && addedIds.length) {
    // Moving each to "play next" in reverse keeps their order at the front.
    for (const [i, id] of [...addedIds].reverse().entries()) {
      const moved = await send({ type: 'move', trackId: id, playNext: true }, i);
      if (!moved?.ok) {
        results.push({ playNext: 'failed', error: replyError(moved) });
        break;
      }
    }
  }
  return { command: 'add', ok: addedLabels.length > 0, results };
}

export async function runDj(ctx: ToolContext, input: { channel?: string; commands: Step[] }, callId: string): Promise<string> {
  const resolved = await resolveChannel(ctx, input.channel);
  if ('error' in resolved) return resolved.error;
  const session = await getSession(resolved.channelId);
  if (!session)
    return `DJ mode isn't on in <#${resolved.channelId}>. If the huddle is in another channel, pass its id as channel; otherwise turn DJ mode on with huddle_dj_mode first.`;
  if (session.status === 'pending') return 'Still waiting for the huddle host to approve DJ mode; nothing can be controlled yet.';
  const limited = await takeLimit('dj', ctx.speakerId, ctx.threadId);
  if (limited) return limited;

  const results: StepResult[] = [];
  for (const [i, step] of input.commands.entries()) {
    const res = await runStep(session, step, `dj:${ctx.turnId ?? 'x'}:${callId}:${i}`);
    results.push(res);
    if (res.lost) {
      await deleteSession(session);
      break;
    }
    if (res.unreachable) break;
  }
  if (input.commands.some((s) => !READ_ONLY.has(s.command)) && !results.some((r) => r.lost)) await scheduleSync(session.channelId, 'dj tool');
  log.info({ channelId: session.channelId, commands: input.commands.map((c) => c.command), ok: results.map((r) => r.ok) }, 'huddle dj commands');
  return json({ channel: session.channelId, results });
}

// ---------- huddle_dj_settings ----------

export async function djSettings(ctx: ToolContext, input: { channel?: string; auto_dj?: boolean; chatter?: boolean; vibe?: string }): Promise<string> {
  const resolved = await resolveChannel(ctx, input.channel);
  if ('error' in resolved) return resolved.error;
  if (input.auto_dj === undefined && input.chatter === undefined && input.vibe === undefined) return 'Nothing to change: pass auto_dj, chatter and/or vibe.';
  const vibe = input.vibe === undefined ? undefined : input.vibe.trim().slice(0, 300) || null;
  const session = await updateSettings(resolved.channelId, { autoDj: input.auto_dj, chatter: input.chatter, vibe });
  if (!session) return `DJ mode isn't on in <#${resolved.channelId}>. Turn it on with huddle_dj_mode first (it takes these settings too).`;
  if (session.status === 'active' && session.autoDj && (input.auto_dj || vibe !== undefined)) {
    await clearBackoff(session.channelId);
    await scheduleSync(session.channelId, 'settings', 0);
  }
  const pending = session.status === 'pending' ? ' (DJ mode is still waiting for the host; this applies once they approve)' : '';
  return `Settings for <#${session.channelId}>: auto DJ ${session.autoDj ? 'on' : 'off'}${session.vibe ? `, vibe "${session.vibe}"` : ''}, chatter ${session.chatter ? 'on' : 'off'}${pending}.${
    session.autoDj && vibe !== undefined && session.status === 'active' ? ' New picks follow the vibe; songs already queued stay unless you remove them.' : ''
  }`;
}

// ---------- registry ----------

const channelInput = z.string().optional().describe("The huddle's channel id (e.g. C0123ABC). Omit for the current channel.");

export function djTools(ctx: ToolContext) {
  return {
    huddle_dj_mode: tool({
      description:
        'Turn DJ mode on or off for a Slack huddle running HuddleFM (the huddle music player). On: asks the huddle host to let you control the music; ' +
        'they must approve it in HuddleFM, and you get a notice turn here when they answer. Off: releases control (or cancels a pending request).',
      inputSchema: z.object({
        enabled: z.boolean(),
        channel: channelInput,
        auto_dj: z.boolean().optional().describe('Pick songs yourself and keep the queue going (default true)'),
        chatter: z.boolean().optional().describe('Chime in now and then when a song starts (default false; only if they ask for it)'),
        vibe: z.string().max(300).optional().describe('What people want the auto DJ to play, in their words ("90s rnb", "chill, no sad songs")'),
      }),
      execute: (input, options) => djMode(ctx, input, toolCallId(options)),
    }),
    huddle_dj: tool({
      description:
        'Control the music once DJ mode is on: queue songs, skip, pause, volume, edit the queue. Put every step of a request in ONE call as commands; they run in order ' +
        '(e.g. "skip this, queue X and Y, turn it down" = skip, add with queries, volume). <huddle_dj> already shows now playing and up next with track ids: use status only for the full queue or settings.',
      inputSchema: z.object({
        channel: channelInput,
        commands: z.array(StepSchema).min(1).max(limits.djMaxCommandsPerCall),
      }),
      execute: (input, options) => runDj(ctx, input, toolCallId(options)),
    }),
    huddle_dj_settings: tool({
      description:
        'Change DJ mode settings: auto_dj (you pick songs and keep the queue going), vibe (what the auto DJ plays; "" clears it), chatter (a short line in this thread now and then when a song starts).',
      inputSchema: z.object({
        channel: channelInput,
        auto_dj: z.boolean().optional(),
        vibe: z.string().max(300).optional(),
        chatter: z.boolean().optional(),
      }),
      execute: (input) => djSettings(ctx, input),
    }),
  };
}

export const DJ_TOOL_NAMES = ['huddle_dj_mode', 'huddle_dj', 'huddle_dj_settings'] as const;
