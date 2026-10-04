/**
 * Admin confirmation before a coding agent launches. spawn_coding_agent only proposes: the task is stored as a pending
 * launch and the admin gets an ephemeral preview with the exact title and task as they will be sent, plus Launch /
 * Cancel. Only ADMIN_USER_ID pressing Launch starts it (checked here, on the click). Same pattern as send_message's
 * confirmation (src/features/send/): server-side pending row with expiry, atomic claim (double clicks launch once),
 * stale-click replies, idempotent preview post. The launched agent gets a plan card of its own in the thread (and the
 * preview is deleted: the card is the feedback). Cancel, a failed launch and expiry start an outcome turn so the agent
 * can acknowledge it (src/features/outcome-turn.ts); while the preview is pending a DM session shows `suspended`.
 *
 * Why: everything a turn's model reads (thread history, other people's messages, fetched pages, subagent results)
 * can carry injected instructions; a human look at the exact task is the last gate before code changes start.
 */
import type { TransactionSql } from 'postgres';
import { env, limits } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { appendEvent, parseThreadId } from '../../core/events.js';
import { slackCall } from '../../core/slack.js';
import type { TurnRow } from '../../core/types.js';
import { sql } from '../../db/index.js';
import { checkEntry, takeLimit } from '../../features/guard.js';
import { settleWithOutcome } from '../../features/outcome-turn.js';
import { deleteOriginal, ephemeral, respond } from '../../features/util.js';
import { resumeSuspendedSession } from '../../pipeline/agent-session.js';
import { log } from '../../log.js';
import { postCard } from '../cards.js';
import { ToolError } from '../subagents.js';
import { oneLine } from '../util.js';
import { activeCodingRuns, cursorConfig, cursorInstructRefusal, spawnCodingAgent } from './agents.js';
import {
  CODING_INSTRUCTIONS_MAX,
  decideLaunchClick,
  LAUNCH_CLICK_REPLIES,
  launchOutcomeFallback,
  launchOutcomeIsMention,
  launchPreviewBlocks,
  renderLaunchOutcome,
  type LaunchDecision,
  type LaunchOutcome,
  type PendingLaunchRow,
} from './confirm-logic.js';

const ttlMin = () => Math.round(limits.cursorConfirmTtlMs / 60_000);

/** spawn_coding_agent: validate, store the pending launch and show the admin the preview. Nothing starts here. */
export async function proposeCodingAgent(o: {
  threadId: string;
  channelId: string;
  threadTs: string;
  turnId: number;
  turnKind: TurnRow['kind'] | undefined;
  ownerId: string;
  title: string;
  instructions: string;
}): Promise<{ pendingId: string; reused: boolean }> {
  const refusal = cursorInstructRefusal(o.ownerId, o.turnKind);
  if (refusal) throw new ToolError(refusal);
  const cfg = cursorConfig()!;
  const title = oneLine(o.title, 80) || 'Coding agent';
  const instructions = o.instructions.trim();
  if (!instructions) throw new ToolError('The instructions are empty.');
  if (instructions.length > CODING_INSTRUCTIONS_MAX)
    throw new ToolError(`The instructions are too long (${instructions.length} chars, max ${CODING_INSTRUCTIONS_MAX}). Make them more concise.`);
  // Fail early on limits the launch would hit anyway (re-checked atomically when it launches).
  const limited = await takeLimit('subagent', o.ownerId, o.threadId);
  if (limited) throw new ToolError(limited);
  if ((await activeCodingRuns()) >= limits.cursorMaxActive)
    throw new ToolError(`${limits.cursorMaxActive} coding agents are already running. Wait for one to finish (or cancel one) first.`);

  // The same proposal repeated (model retry) → the preview already shown.
  const [existing] = await sql<{ id: string }[]>`
    select id from pending_coding_agents where owner_id = ${o.ownerId} and thread_id = ${o.threadId} and title = ${title}
      and instructions = ${instructions} and status = 'pending' and expires_at > now()`;
  if (existing) return { pendingId: existing.id, reused: true };

  const [row] = await sql<{ id: string }[]>`
    insert into pending_coding_agents (thread_id, turn_id, owner_id, title, instructions, expires_at)
    values (${o.threadId}, ${o.turnId}, ${o.ownerId}, ${title}, ${instructions}, ${new Date(Date.now() + limits.cursorConfirmTtlMs)})
    returning id`;
  const pendingId = row!.id;
  await slackCall(
    'chat.postEphemeral',
    {
      channel: o.channelId,
      user: o.ownerId,
      thread_ts: o.threadTs,
      text: `Launch a coding agent: ${title}?`,
      blocks: launchPreviewBlocks({ pendingId, title, instructions, repoUrl: cfg.repoUrl, ref: cfg.ref, ttlMin: ttlMin() }),
    },
    { idempotencyKey: `coding-confirm:${pendingId}` },
  );
  await appendEvent(o.threadId, 'coding_agent_proposed', o.ownerId, { pendingId, title, turnId: o.turnId }).catch(() => {});
  return { pendingId, reused: false };
}

async function loadPending(id: string | undefined): Promise<PendingLaunchRow | undefined> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await sql<PendingLaunchRow[]>`select * from pending_coding_agents where id = ${id}`;
  return row;
}

async function replyDecision(ctx: ActionContext, d: Exclude<LaunchDecision, 'ok'>) {
  const r = LAUNCH_CLICK_REPLIES[d];
  // A second click on a preview already removed after launching: nothing to replace, no new ephemeral.
  if (d === 'launched') return void (await respond(ctx.responseUrl, { replace_original: true, text: r.text }));
  await ephemeral(ctx, r.text, { replace: r.replace });
}

/** Conditional status change of a pending launch (true = this call changed it). */
const transitionTo = (id: string, from: 'pending' | 'launching', to: 'cancelled' | 'expired' | 'failed', when: 'live' | 'expired' | 'any', error?: string) =>
  async (tx: TransactionSql<{}>) => {
    const expiry = when === 'live' ? sql`and expires_at > now()` : when === 'expired' ? sql`and expires_at <= now()` : sql``;
    const rows = await tx`
      update pending_coding_agents set status = ${to}, error = coalesce(${error ?? null}, error)
      where id = ${id} and status = ${from} ${expiry} returning id`;
    return rows.length > 0;
  };

/**
 * Resolve a pending launch without starting it (Cancel, a failed Launch, expiry) and tell the agent in an outcome turn
 * (exactly once; src/features/outcome-turn.ts). A DM session suspended for it resumes unless a mention turn will set
 * its status itself.
 */
async function settleLaunch(p: PendingLaunchRow, outcome: LaunchOutcome, transition: (tx: TransactionSql<{}>) => Promise<boolean>) {
  const isMention = launchOutcomeIsMention(outcome);
  const res = await settleWithOutcome({
    threadId: p.threadId,
    speakerId: p.ownerId,
    source: 'coding_launch',
    sourceRef: p.id,
    input: renderLaunchOutcome({ pendingId: p.id, ownerId: p.ownerId, title: p.title, outcome }),
    fallback: launchOutcomeFallback(outcome),
    isMention,
    transition,
  });
  if (res.settled && (res.turnId == null || !isMention)) await resumeSuspendedSession(p.threadId);
  return res;
}

export async function handleCodingCancel(ctx: ActionContext): Promise<void> {
  const p = await loadPending(ctx.value);
  const d = decideLaunchClick(p, ctx.userId, env.ADMIN_USER_ID);
  if (d !== 'ok') return replyDecision(ctx, d);
  const res = await settleLaunch(p!, { kind: 'cancelled' }, transitionTo(p!.id, 'pending', 'cancelled', 'live'));
  if (!res.settled) {
    const again = decideLaunchClick(await loadPending(p!.id), ctx.userId, env.ADMIN_USER_ID);
    return replyDecision(ctx, again === 'ok' ? 'expired' : again);
  }
  await appendEvent(p!.threadId, 'coding_agent_declined', ctx.userId, { pendingId: p!.id }).catch(() => {});
  await ephemeral(ctx, LAUNCH_CLICK_REPLIES.cancelled.text, { replace: true });
}

export async function handleCodingLaunch(ctx: ActionContext): Promise<void> {
  const p = await loadPending(ctx.value);
  const d = decideLaunchClick(p, ctx.userId, env.ADMIN_USER_ID);
  if (d !== 'ok') return replyDecision(ctx, d);
  // The bot must still be allowed to act in this channel (global pause / suspension are checked by the dispatcher).
  const entry = await checkEntry(ctx.userId, parseThreadId(p!.threadId).channelId, { countMessage: false });
  if (!entry.ok) return ephemeral(ctx, `Can't launch right now (${entry.reason}).`);

  // Claim atomically: a double click or a second worker launches once.
  const [c] = await sql<PendingLaunchRow[]>`
    update pending_coding_agents set status = 'launching' where id = ${p!.id} and status = 'pending' and expires_at > now() returning *`;
  if (!c) {
    const again = decideLaunchClick(await loadPending(p!.id), ctx.userId, env.ADMIN_USER_ID);
    return replyDecision(ctx, again === 'ok' ? 'expired' : again);
  }
  const fail = async (msg: string) => {
    await settleLaunch(c, { kind: 'failed', error: msg }, transitionTo(c.id, 'launching', 'failed', 'any', msg));
    await ephemeral(ctx, `Not launched: ${msg}`, { replace: true });
  };
  const [th] = await sql<{ rootDeletedAt: Date | null }[]>`select root_deleted_at from threads where id = ${c.threadId}`;
  if (!th || th.rootDeletedAt) return fail('the thread was deleted. Ask again somewhere else.');

  let r: Awaited<ReturnType<typeof spawnCodingAgent>>;
  try {
    // The pending id doubles as the client-supplied Cursor agent id: a retried launch can't create a second agent.
    r = await spawnCodingAgent({ threadId: c.threadId, turnId: null, ownerId: c.ownerId, title: c.title, instructions: c.instructions, agentId: `bc-${c.id}` });
  } catch (err) {
    log.warn({ err, pendingId: c.id }, 'coding agent launch failed');
    return fail(err instanceof ToolError ? err.message : 'something went wrong. Try asking again.');
  }
  await sql`update pending_coding_agents set status = 'launched', subagent_id = ${r.subagentId} where id = ${c.id}`;
  await resumeSuspendedSession(c.threadId); // a DM session waiting for this launch → active
  // The plan card in the thread is the visible feedback (the PR link and summary follow there): the preview goes
  // away. Only if the card couldn't be posted does the preview turn into the confirmation.
  const cardPosted = await postCard(r.cardId).then(
    () => true,
    (err) => (log.error({ err, cardId: r.cardId }, 'posting the coding agent card failed'), false),
  );
  if (cardPosted && (await deleteOriginal(ctx))) return;
  await ephemeral(ctx, `Launched ✓ ${c.title}: it shows on the plan card in this thread. The PR link and summary come here when it's done.`, { replace: true });
}

/** Outcome turns only for previews that expired recently (a sweep after downtime doesn't dig up old ones). */
const OUTCOME_MAX_AGE_MS = 60 * 60 * 1000;

/** Maintenance: expire unanswered previews (the agent hears about it); drop old rows (they only matter while pending). */
export async function expirePendingLaunches(): Promise<void> {
  const due = await sql<PendingLaunchRow[]>`
    select * from pending_coding_agents where status = 'pending' and expires_at <= now() order by expires_at limit 200`;
  for (const p of due) {
    const transition = transitionTo(p.id, 'pending', 'expired', 'expired');
    try {
      if (Date.now() - new Date(p.expiresAt).getTime() < OUTCOME_MAX_AGE_MS) await settleLaunch(p, { kind: 'expired', ttlMin: ttlMin() }, transition);
      else if (await sql.begin(transition)) await resumeSuspendedSession(p.threadId);
    } catch (err) {
      log.warn({ err, pendingId: p.id }, 'expiring a pending coding agent launch failed');
    }
  }
  // A click that crashed mid-launch: the agent (if any) is tracked by its own rows; just make the state honest.
  const stuck = await sql<{ threadId: string }[]>`
    update pending_coding_agents set status = 'failed', error = 'interrupted'
    where status = 'launching' and expires_at <= now() - interval '10 minutes' returning thread_id`;
  for (const threadId of new Set(stuck.map((s) => s.threadId))) await resumeSuspendedSession(threadId);
  await sql`delete from pending_coding_agents where created_at < now() - interval '30 days'`;
}
