/**
 * Admin confirmation before a coding agent launches. spawn_coding_agent only proposes: the task is stored as a pending
 * launch and the admin gets an ephemeral preview with the exact title and task as they will be sent, plus Launch /
 * Cancel. Only ADMIN_USER_ID pressing Launch starts it (checked here, on the click). Same pattern as send_message's
 * confirmation (src/features/send/): server-side pending row with expiry, atomic claim (double clicks launch once),
 * stale-click replies, idempotent preview post. The launched agent gets a plan card of its own in the thread.
 *
 * Why: everything a turn's model reads (thread history, other people's messages, fetched pages, subagent results)
 * can carry injected instructions; a human look at the exact task is the last gate before code changes start.
 */
import { env, limits } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { appendEvent, parseThreadId } from '../../core/events.js';
import { slackCall } from '../../core/slack.js';
import type { TurnRow } from '../../core/types.js';
import { sql } from '../../db/index.js';
import { checkEntry, takeLimit } from '../../features/guard.js';
import { ephemeral } from '../../features/util.js';
import { log } from '../../log.js';
import { postCard } from '../cards.js';
import { ToolError } from '../subagents.js';
import { oneLine } from '../util.js';
import { activeCodingRuns, cursorConfig, cursorInstructRefusal, spawnCodingAgent } from './agents.js';
import { CODING_INSTRUCTIONS_MAX, decideLaunchClick, LAUNCH_CLICK_REPLIES, launchPreviewBlocks, type LaunchDecision, type PendingLaunchRow } from './confirm-logic.js';

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
  await ephemeral(ctx, r.text, { replace: r.replace });
}

export async function handleCodingCancel(ctx: ActionContext): Promise<void> {
  const p = await loadPending(ctx.value);
  const d = decideLaunchClick(p, ctx.userId, env.ADMIN_USER_ID);
  if (d !== 'ok') return replyDecision(ctx, d);
  await sql`update pending_coding_agents set status = 'cancelled' where id = ${p!.id} and status = 'pending'`;
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
    await sql`update pending_coding_agents set status = 'failed', error = ${msg} where id = ${c.id}`;
    await ephemeral(ctx, `Not launched: ${msg}`, { replace: true });
  };
  const [th] = await sql<{ rootDeletedAt: Date | null }[]>`select root_deleted_at from threads where id = ${c.threadId}`;
  if (!th || th.rootDeletedAt) return fail('the thread was deleted. Ask again somewhere else.');

  try {
    // The pending id doubles as the client-supplied Cursor agent id: a retried launch can't create a second agent.
    const r = await spawnCodingAgent({ threadId: c.threadId, turnId: null, ownerId: c.ownerId, title: c.title, instructions: c.instructions, agentId: `bc-${c.id}` });
    await sql`update pending_coding_agents set status = 'launched', subagent_id = ${r.subagentId} where id = ${c.id}`;
    await postCard(r.cardId).catch((err) => log.error({ err, cardId: r.cardId }, 'posting the coding agent card failed'));
    await ephemeral(ctx, `Launched ✓ ${c.title}: it shows on the plan card in this thread. The PR link and summary come here when it's done.`, { replace: true });
  } catch (err) {
    log.warn({ err, pendingId: c.id }, 'coding agent launch failed');
    await fail(err instanceof ToolError ? err.message : 'something went wrong. Try asking again.');
  }
}

/** Maintenance: expire unanswered previews; drop old rows (they only matter while pending). */
export async function expirePendingLaunches(): Promise<void> {
  await sql`update pending_coding_agents set status = 'expired' where status = 'pending' and expires_at <= now()`;
  // A click that crashed mid-launch: the agent (if any) is tracked by its own rows; just make the state honest.
  await sql`update pending_coding_agents set status = 'failed', error = 'interrupted' where status = 'launching' and expires_at <= now() - interval '10 minutes'`;
  await sql`delete from pending_coding_agents where created_at < now() - interval '30 days'`;
}
