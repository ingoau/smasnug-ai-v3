/**
 * Agent sessions in DMs: the sidebar title and the richer lifecycle statuses. Channel threads keep the plain
 * processing/active indicator (session-status.ts); everything here is gated on `threads.is_dm` (channel_type `im`).
 *
 * Researched 2026-10 on docs.slack.dev (https://docs.slack.dev/ai/agent-sessions/):
 * - Titles: `agents.sessions.rename` (https://docs.slack.dev/reference/methods/agents.sessions.rename, `chat:write`,
 *   1-200 chars) replaces `assistant.threads.setTitle`. `agents.sessions.setStatus`'s `title` is "only used when
 *   creating a new session; ignored if the session already exists" — DM sessions already exist by the time the
 *   model knows the topic (intake sets `processing`), so it is only the fallback when rename says
 *   `session_not_found`.
 * - "Users may change the title of a session at any time, even if the agent previously set it", and the app gets
 *   `agent_session_title_changed` (https://docs.slack.dev/reference/events/agent_session_title_changed: `title`,
 *   `previous_title`, `user`). The docs describe it as sent when "a user changes the title"; in case Slack echoes
 *   our own rename, an event without a human `user`, or one repeating a title we set within the last two minutes
 *   (the current one or an earlier one, from the `session_titled` events), is not taken as a user rename. A
 *   user-chosen title is never overwritten afterwards; one that lands while our rename is in flight is re-applied.
 * - Statuses: `suspended` = "the agent cannot make progress until the user intervenes, for example when the agent
 *   needs user clarification or a tool approval" → a DM turn that leaves a confirmation pending (a send_message
 *   preview, or a coding-agent launch preview) ends `suspended`, and resolving it (Send / Launch / Cancel / expiry)
 *   sets `active` (or the outcome turn it starts does, src/features/outcome-turn.ts). `closed` = "the agent has closed the session
 *   and will no longer respond on it" → leave_thread in a DM ends the turn `closed`; a later message in the thread
 *   sets `processing` again like any turn (the bot always answers DMs).
 */
import { appendEvent, parseThreadId } from '../core/events.js';
import { getBotIdentity, slackCall, slackErrorCode } from '../core/slack.js';
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { isLocked, threadLockKey } from './lock.js';
import { setSessionStatus, turnIndicatorLive, type FinalSessionStatus } from './session-status.js';

/** Sidebar titles are kept short, like plan card titles. */
export const SESSION_TITLE_MAX = 40;
/** An `agent_session_title_changed` repeating our own title within this window is our rename's echo. */
const ECHO_WINDOW_MS = 2 * 60_000;

export interface SessionInfo {
  isDm: boolean;
  title: string | null;
  titleBy: 'bot' | 'user' | null;
}

/** The thread's DM flag and session title (one query; front turns use it for the tool and the prompt). */
export async function loadSessionInfo(threadId: string): Promise<SessionInfo> {
  const [row] = await sql<{ isDm: boolean; title: string | null; titleBy: 'bot' | 'user' | null }[]>`
    select t.is_dm, s.title, s.title_by from threads t left join agent_sessions s on s.thread_id = t.id where t.id = ${threadId}`;
  return { isDm: Boolean(row?.isDm), title: row?.title ?? null, titleBy: row?.titleBy ?? null };
}

/** One line, no Slack markup, at most SESSION_TITLE_MAX chars (cut at a word boundary when possible). */
export function normalizeSessionTitle(raw: string): string {
  let t = raw
    .replace(/<[^>]*>/g, ' ') // mentions, links, broadcasts: never in a title
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if (t.length <= SESSION_TITLE_MAX) return t;
  t = t.slice(0, SESSION_TITLE_MAX - 1);
  const space = t.lastIndexOf(' ');
  if (space >= SESSION_TITLE_MAX / 2) t = t.slice(0, space);
  return `${t.replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * set_session_title: rename this DM thread's session. One title per turn; never over a user-chosen title.
 * Returns the model-facing result.
 */
export async function setSessionTitle(o: { threadId: string; turnId: number; title: string }): Promise<string> {
  const title = normalizeSessionTitle(o.title);
  if (!title) return 'Not renamed: the title was empty.';
  const before = await loadSessionInfo(o.threadId);
  if (!before.isDm) return 'Not renamed: session titles are only for DM conversations.';
  if (before.titleBy === 'user') return `Not renamed: the user named this conversation "${before.title ?? ''}" themselves. Keep their title.`;
  if (before.title === title) return `Title unchanged: "${title}".`;
  // Claim atomically: a user rename that just landed, or an earlier call in this turn, wins.
  const [prev] = await sql<{ title: string | null; titleBy: string | null; titleTurnId: number | null; botTitleAt: Date | null }[]>`
    select title, title_by, title_turn_id, bot_title_at from agent_sessions where thread_id = ${o.threadId}`;
  const claimed = await sql`
    insert into agent_sessions (thread_id, title, title_by, title_turn_id, bot_title_at)
    values (${o.threadId}, ${title}, 'bot', ${o.turnId}, now())
    on conflict (thread_id) do update set title = excluded.title, title_by = 'bot', title_turn_id = excluded.title_turn_id,
      bot_title_at = now(), updated_at = now()
    where agent_sessions.title_by is distinct from 'user' and agent_sessions.title_turn_id is distinct from excluded.title_turn_id
    returning thread_id`;
  if (claimed.length === 0) {
    const now = await loadSessionInfo(o.threadId);
    if (now.titleBy === 'user') return `Not renamed: the user named this conversation "${now.title ?? ''}" themselves. Keep their title.`;
    return `Not renamed: you already titled this conversation this turn ("${now.title ?? ''}").`;
  }
  const { channelId, threadTs } = parseThreadId(o.threadId);
  try {
    await renameSession(channelId, threadTs, title, `session-title:${o.threadId}:${o.turnId}`);
  } catch (err) {
    const code = slackErrorCode(err) ?? 'error';
    log.warn({ err, threadId: o.threadId, code }, 'renaming the agent session failed');
    // Put the previous state back (only if nothing changed it meanwhile), so a later turn can try again.
    await sql`
      update agent_sessions set title = ${prev?.title ?? null}, title_by = ${prev?.titleBy ?? null},
        title_turn_id = ${prev?.titleTurnId ?? null}, bot_title_at = ${prev?.botTitleAt ?? null}, updated_at = now()
      where thread_id = ${o.threadId} and title_by = 'bot' and title_turn_id = ${o.turnId}`.catch(() => {});
    return `Not renamed: Slack refused (${code}).`;
  }
  await appendEvent(o.threadId, 'session_titled', 'bot', { turnId: o.turnId, title }).catch(() => {});
  // A user rename that arrived between our claim and our rename was overwritten in Slack by ours, while the DB says
  // the user's title wins: put theirs back.
  const after = await loadSessionInfo(o.threadId);
  if (after.titleBy === 'user' && after.title) {
    await renameSession(channelId, threadTs, after.title, `session-title:${o.threadId}:${o.turnId}:user`).catch((err) =>
      log.warn({ err, threadId: o.threadId }, "re-applying the user's session title failed"),
    );
    return `Not renamed: the user just named this conversation "${after.title}" themselves. Keep their title.`;
  }
  return `Conversation titled "${title}".`;
}

/** agents.sessions.rename; when the session doesn't exist yet, create it with the title (setStatus `title`). */
async function renameSession(channelId: string, threadTs: string, title: string, key: string) {
  try {
    await slackCall('agents.sessions.rename', { channel_id: channelId, thread_ts: threadTs, title }, { idempotencyKey: key });
  } catch (err) {
    if (slackErrorCode(err) !== 'session_not_found') throw err;
    // No session yet, so no status was ever set: create it with the turn's current one (`processing` only while
    // the turn's indicator shows it; the turn's TurnStatus wouldn't clear a `processing` it never set).
    const status = turnIndicatorLive(`${channelId}:${threadTs}`) ? 'processing' : 'active';
    await slackCall('agents.sessions.setStatus', { channel_id: channelId, thread_ts: threadTs, status, title }, { idempotencyKey: `${key}:create` });
  }
}

export interface AgentSessionTitleChangedEvent {
  type: 'agent_session_title_changed';
  channel?: string;
  thread_ts?: string;
  title?: string;
  previous_title?: string;
  user?: string;
  event_ts?: string;
}

/** A session was renamed in Slack: remember a user's choice (DM threads only) so we never overwrite it. */
export async function handleSessionTitleChanged(ev: AgentSessionTitleChangedEvent): Promise<void> {
  const { channel, thread_ts: threadTs, title } = ev;
  if (!channel || !threadTs || typeof title !== 'string') return;
  const threadId = `${channel}:${threadTs}`;
  const bot = await getBotIdentity().catch(() => null);
  if (!ev.user || ev.user === bot?.userId) {
    log.debug({ threadId }, 'agent session renamed by the app (echo)');
    return;
  }
  const [row] = await sql<{ isDm: boolean; title: string | null; titleBy: string | null; botTitleAt: Date | null }[]>`
    select t.is_dm, s.title, s.title_by, s.bot_title_at from threads t left join agent_sessions s on s.thread_id = t.id where t.id = ${threadId}`;
  if (!row?.isDm) {
    log.info({ threadId }, 'agent session renamed outside a DM thread we track');
    return;
  }
  if (row.titleBy === 'bot' && row.title === title && row.botTitleAt && Date.now() - row.botTitleAt.getTime() < ECHO_WINDOW_MS) {
    log.debug({ threadId }, 'agent session title event repeats our own rename (echo)');
    return;
  }
  // A late echo of an earlier rename of ours (the bot retitled since): any title we set within the window.
  const [recent] = await sql<{ ours: boolean }[]>`
    select exists (select 1 from thread_events where thread_id = ${threadId} and type = 'session_titled' and actor = 'bot'
      and payload->>'title' = ${title} and created_at > now() - ${ECHO_WINDOW_MS} * interval '1 millisecond') as ours`;
  if (recent?.ours && row.titleBy !== 'user') {
    log.debug({ threadId }, 'agent session title event repeats an earlier rename of ours (echo)');
    return;
  }
  await sql`
    insert into agent_sessions (thread_id, title, title_by, user_renamed_at)
    values (${threadId}, ${title}, 'user', now())
    on conflict (thread_id) do update set title = excluded.title, title_by = 'user', user_renamed_at = now(), updated_at = now()`;
  await appendEvent(threadId, 'session_renamed', ev.user, { title }).catch(() => {});
  log.info({ threadId, user: ev.user }, 'user renamed the agent session');
}

/** leave_thread in a DM: this turn ends with the session `closed`. Returns false outside DMs. */
export async function requestSessionClose(threadId: string, turnId: number): Promise<boolean> {
  const rows = await sql`
    insert into agent_sessions (thread_id, close_turn_id)
    select id, ${turnId} from threads where id = ${threadId} and is_dm
    on conflict (thread_id) do update set close_turn_id = excluded.close_turn_id, updated_at = now()
    returning thread_id`;
  return rows.length > 0;
}

/** Whether thread `t` has a confirmation the user still has to answer: a send_message or coding-agent launch preview. */
const AWAITING_USER = sql`(
  exists (select 1 from pending_sends p where p.thread_id = t.id and p.status = 'pending' and p.expires_at > now())
  or exists (select 1 from pending_coding_agents c where c.thread_id = t.id and c.status = 'pending' and c.expires_at > now()))`;

/**
 * The status a turn leaves its session in. DMs: `suspended` while a confirmation from this thread is pending
 * (the user has to act), `closed` after leave_thread in this turn, else `active`. Channel threads: always `active`.
 * Without `turnId` (side paths that clear a status outside a turn: intake, stop, a resolved confirmation): the
 * status the session rests in, i.e. `closed` if the latest turn that ran (or runs) is the one that closed it.
 */
export async function finalSessionStatus(threadId: string, turnId?: number): Promise<FinalSessionStatus> {
  const [row] = await sql<{ isDm: boolean; closeTurnId: number | null; pendingSend: boolean; lastTurnId: number | null }[]>`
    select t.is_dm, s.close_turn_id, ${AWAITING_USER} as pending_send,
      (select max(u.id) from turns u where u.thread_id = t.id and u.status <> 'pending') as last_turn_id
    from threads t left join agent_sessions s on s.thread_id = t.id where t.id = ${threadId}`;
  if (!row?.isDm) return 'active';
  if (row.pendingSend) return 'suspended';
  const turn = turnId ?? row.lastTurnId;
  if (row.closeTurnId != null && turn != null && Number(row.closeTurnId) === Number(turn)) return 'closed';
  return 'active';
}

/** Set the session's resting status (finalSessionStatus without a turn) from a side path. Never throws. */
export async function restoreSessionStatus(threadId: string, userId?: string): Promise<void> {
  const status = await finalSessionStatus(threadId).catch((err) => (log.warn({ err, threadId }, 'finalSessionStatus failed'), 'active' as const));
  const { channelId, threadTs } = parseThreadId(threadId);
  await setSessionStatus(channelId, threadTs, status, userId);
}

/** Suspended DM sessions by the time their earliest pending confirmation expires (ms): resumed by the sweep below. */
const SUSPENDED_KEY = 'sessions:suspended';

/**
 * A turn left a DM session `suspended`: remember when its confirmation expires, so the session resumes then (the
 * pending-send expiry sweep runs only every few minutes). Never throws.
 */
export async function noteSessionSuspended(threadId: string): Promise<void> {
  try {
    const [row] = await sql<{ at: Date | null }[]>`
      select min(expires_at) as at from (
        select expires_at from pending_sends where thread_id = ${threadId} and status = 'pending' and expires_at > now()
        union all
        select expires_at from pending_coding_agents where thread_id = ${threadId} and status = 'pending' and expires_at > now()) w`;
    if (row?.at) await redis.zadd(SUSPENDED_KEY, new Date(row.at).getTime(), threadId);
  } catch (err) {
    log.warn({ err, threadId }, 'noting a suspended session failed');
  }
}

/**
 * Maintenance (every few seconds): resume suspended sessions whose confirmation has expired. An entry stays until it
 * is resolved: a thread whose lock is held (a turn, e.g. the expiry's own silent outcome turn, is running) is retried
 * on the next sweep (and by the thread run after it releases the lock), not dropped.
 */
export async function resumeExpiredSuspensions(): Promise<void> {
  const due = await redis.zrangebyscore(SUSPENDED_KEY, 0, Date.now());
  for (const threadId of due) await resumeSuspendedSession(threadId);
}

/** The session was noted `suspended` and not resumed yet (thread runs re-check these after releasing the lock). */
export async function isNotedSuspended(threadId: string): Promise<boolean> {
  return (await redis.zscore(SUSPENDED_KEY, threadId).catch(() => null)) != null;
}

/** A turn just set the session's status itself (its indicator was shown) and it isn't `suspended`: forget the note. */
export async function noteSessionSettled(threadId: string): Promise<void> {
  await redis.zrem(SUSPENDED_KEY, threadId).catch(() => {});
}

/**
 * A confirmation was resolved (Send / Launch, Cancel or expiry): a DM session suspended for it goes back to `active`,
 * unless another confirmation is still pending or a turn is running (that turn sets the final status; the thread run
 * re-checks after releasing the lock; the expiry sweep keeps its entry). Never throws.
 */
export async function resumeSuspendedSession(threadId: string | null | undefined): Promise<void> {
  if (!threadId) return;
  try {
    const [row] = await sql<{ isDm: boolean; pendingSend: boolean }[]>`
      select t.is_dm, ${AWAITING_USER} as pending_send from threads t where t.id = ${threadId}`;
    if (!row?.isDm) return void (await redis.zrem(SUSPENDED_KEY, threadId));
    if (row.pendingSend) return void (await noteSessionSuspended(threadId)); // resume when the next one expires
    if (await isLocked(threadLockKey(threadId))) return;
    await redis.zrem(SUSPENDED_KEY, threadId);
    await restoreSessionStatus(threadId); // `active` (or `closed` if the conversation was closed meanwhile)
  } catch (err) {
    log.warn({ err, threadId }, 'resuming a suspended session failed');
  }
}
