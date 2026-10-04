/**
 * Coding agents: Cursor Cloud Agents as admin-only subagents (kind 'cursor'). They live in the same tables as model
 * subagents (subagents / runs / plan cards), so they show on the plan card, get the same synthesis turn when they
 * finish, and are steered / cancelled through message_subagent / cancel_subagent. What differs:
 *
 * - Admin only, enforced here (not in the prompt): starting, steering and cancelling need the speaker to be
 *   ADMIN_USER_ID and CURSOR_API_KEY + CURSOR_REPO to be set. Bulk cancels by anyone else (old "Stop all" buttons, a
 *   deleted thread root) leave coding agents running.
 * - The bot run is backed by Cursor runs (table cursor_runs). There is no worker loop: a maintenance task polls
 *   Cursor every limits.cursorPollMs. Postgres is the source of truth and pollers claim one due row at a time
 *   (`for update skip locked`, claim id + lease, like reminders), so two workers never handle the same poll, and
 *   restarts / deploys don't matter (nothing is held in memory; the stale-heartbeat sweeper and shutdown hook skip
 *   these runs). Delayed BullMQ jobs per run were the alternative; polling the DB needs no job bookkeeping on
 *   cancel / restart / Redis loss, and 30 s precision is plenty for 10–60 min tasks.
 * - Steering: Cursor can't inject a message into a running cloud run (see api.ts), so a steer is queued in the
 *   subagent inbox and sent as a follow-up Cursor run (same conversation, branch and PR) as soon as the current one
 *   finishes; the bot run (card row) stays running until Cursor is done with everything.
 * - Own timeout (limits.cursorRunMaxMs, 3h): the Cursor run is cancelled and the bot run fails.
 */
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { env, limits } from '../../config.js';
import { appendEvent, shortId } from '../../core/events.js';
import { sql } from '../../db/index.js';
import { takeLimit } from '../../features/guard.js';
import { log } from '../../log.js';
import { ensureTurnCard, scheduleCardRender } from '../cards.js';
import { finishRun, ToolError, type MessageResult, type RunOutcome, type SubagentRow } from '../subagents.js';
import { addSource, deriveSteerNote, oneLine, type RunSource } from '../util.js';
import {
  CursorApiError,
  cursorClient,
  describeRunStatus,
  isCiPath,
  isRunActive,
  parseGithubPr,
  pickBranch,
  prChangedFiles,
  type CursorAgent,
  type CursorClient,
  type CursorRun,
} from './api.js';
import { composeCursorFollowUp, composeCursorPrompt } from './prompt.js';

export interface CursorConfig {
  repoUrl: string;
  ref: string;
  model: string | null;
}

/** Repo + ref when coding agents are configured (key and a valid https repo URL), else null. */
export function cursorConfig(): CursorConfig | null {
  if (!env.CURSOR_API_KEY || !env.CURSOR_REPO) return null;
  let url: URL;
  try {
    url = new URL(env.CURSOR_REPO.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { repoUrl: url.toString().replace(/\/+$/, ''), ref: env.CURSOR_REF.trim() || 'main', model: env.CURSOR_MODEL?.trim() || null };
}

export const isCursorAdmin = (userId: string | null | undefined) => !!env.ADMIN_USER_ID && userId === env.ADMIN_USER_ID;

/** Why `userId` may not start / steer / cancel a coding agent right now, or null if they may. */
export function cursorRefusal(userId: string): string | null {
  if (!cursorConfig() || !cursorClient()) return "Coding agents aren't set up on this bot (CURSOR_API_KEY / CURSOR_REPO). Tell the speaker briefly.";
  if (!isCursorAdmin(userId))
    return "Only the bot's admin can start, steer or stop coding agents (they change the bot's own code). Politely tell the speaker that; don't retry.";
  return null;
}

// ---------- test seams ----------

type PrFiles = typeof prChangedFiles;
let prFilesImpl: PrFiles = prChangedFiles;
/** Tests: replace the GitHub PR-files lookup. */
export function setPrFilesForTests(fn: PrFiles | null) {
  prFilesImpl = fn ?? prChangedFiles;
}

function client(): CursorClient {
  const c = cursorClient();
  if (!c) throw new ToolError("Coding agents aren't set up on this bot.");
  return c;
}

const errText = (err: unknown) => oneLine(err instanceof Error ? err.message : String(err), 200);

async function setSources(runId: number, sources: RunSource[]) {
  await sql`update runs set sources = ${sql.json(sources as any)} where id = ${runId}`;
}

function sourcesFor(agentUrl: string | null | undefined, prUrl?: string | null): RunSource[] {
  const list: RunSource[] = [];
  if (prUrl) addSource(list, prUrl, `Pull request #${parseGithubPr(prUrl)?.number ?? ''}`.trim());
  if (agentUrl) addSource(list, agentUrl, 'Cursor agent');
  return list;
}

async function activeCodingRuns(): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from runs r join subagents s on s.id = r.subagent_id where s.kind = 'cursor' and r.status in ('queued', 'running')`;
  return r?.n ?? 0;
}

/** POST /v1/agents with a client-supplied id: a retry (or a 409 agent_id_conflict) never creates a second agent. */
async function launchAgent(c: CursorClient, input: Parameters<CursorClient['createAgent']>[0]): Promise<{ agent: CursorAgent; run: CursorRun | null }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await c.createAgent(input);
    } catch (err) {
      if (err instanceof CursorApiError && err.code === 'agent_id_conflict') {
        const agent = await c.getAgent(input.agentId);
        return { agent, run: agent.latestRunId ? { id: agent.latestRunId, agentId: agent.id, status: 'CREATING' } : null };
      }
      if (attempt === 0 && err instanceof CursorApiError && err.status === 0) continue; // network blip: same agentId again
      throw err;
    }
  }
}

// ---------- start / steer / resume / cancel ----------

export async function spawnCodingAgent(opts: {
  threadId: string;
  turnId: number;
  ownerId: string;
  title: string;
  instructions: string;
}): Promise<{ subagentId: string; runId: number; cardId: number; agentUrl: string | null }> {
  const refusal = cursorRefusal(opts.ownerId);
  if (refusal) throw new ToolError(refusal);
  const cfg = cursorConfig()!;
  const c = client();
  const limited = await takeLimit('subagent', opts.ownerId, opts.threadId);
  if (limited) throw new ToolError(limited);
  if ((await activeCodingRuns()) >= limits.cursorMaxActive)
    throw new ToolError(`${limits.cursorMaxActive} coding agents are already running. Wait for one to finish (or cancel one) first.`);

  const subagentId = shortId('sa');
  const agentId = `bc-${randomUUID()}`;
  const title = oneLine(opts.title, 80) || 'Coding agent';
  const cardId = await ensureTurnCard({ threadId: opts.threadId, turnId: opts.turnId });
  const runId = await sql.begin(async (tx) => {
    await tx`insert into subagents (id, thread_id, owner_id, title, status, kind, cursor_agent_id)
             values (${subagentId}, ${opts.threadId}, ${opts.ownerId}, ${title}, 'running', 'cursor', ${agentId})`;
    const [run] = await tx<{ id: number }[]>`
      insert into runs (subagent_id, thread_id, card_id, turn_id, instructions, is_resume, status, model, details, started_at, heartbeat_at)
      values (${subagentId}, ${opts.threadId}, ${cardId}, ${opts.turnId}, ${opts.instructions}, false, 'running',
              ${`cursor:${cfg.model ?? 'default'}`}, ${describeRunStatus('CREATING', 0)}, now(), now())
      returning id`;
    const id = Number(run!.id);
    await tx`insert into cursor_runs (run_id, agent_id, next_poll_at) values (${id}, ${agentId}, now() + ${limits.cursorPollMs / 1000} * interval '1 second')`;
    return id;
  });

  let launched: Awaited<ReturnType<typeof launchAgent>>;
  try {
    launched = await launchAgent(c, {
      agentId,
      promptText: composeCursorPrompt(opts.instructions, cfg),
      name: title,
      repoUrl: cfg.repoUrl,
      ref: cfg.ref,
      model: cfg.model ?? undefined,
    });
  } catch (err) {
    // Nothing started: drop the rows again (the card stays unposted without runs) and let the model tell the admin.
    await sql`delete from subagents where id = ${subagentId}`;
    log.warn({ err: errText(err), threadId: opts.threadId }, 'cursor agent launch failed');
    throw new ToolError(`Couldn't start the coding agent: ${errText(err)}`);
  }
  const agentUrl = launched.agent.url ?? null;
  await sql`update cursor_runs set cursor_run_id = ${launched.run?.id ?? null}, cursor_status = ${launched.run?.status ?? null} where run_id = ${runId}`;
  await sql`update subagents set cursor_agent_url = ${agentUrl} where id = ${subagentId}`;
  await setSources(runId, sourcesFor(agentUrl));
  await appendEvent(opts.threadId, 'spawn', opts.ownerId, {
    subagentId,
    runId,
    cardId,
    title,
    kind: 'cursor',
    agentId,
    cursorRunId: launched.run?.id ?? null,
    instructions: opts.instructions,
  });
  await scheduleCardRender(cardId);
  return { subagentId, runId, cardId, agentUrl };
}

/**
 * message_subagent on a coding agent. Running → queued in the inbox (shown on the card row) and sent as a follow-up
 * Cursor run when the current run finishes. Idle → a new bot run on this turn's card, backed by a follow-up Cursor
 * run on the same agent (same branch / PR).
 */
export async function messageCodingAgent(
  opts: { threadId: string; turnId: number; speakerId: string; subagentId: string; text: string; note?: string },
  pre: SubagentRow,
): Promise<MessageResult> {
  const refusal = cursorRefusal(opts.speakerId);
  if (refusal) throw new ToolError(refusal);
  const cfg = cursorConfig()!;
  if (pre.status === 'running') {
    const res = await sql.begin(async (tx) => {
      const [sa] = await tx<{ status: string }[]>`select status from subagents where id = ${pre.id} for update`;
      if (sa?.status !== 'running') return null;
      await tx`insert into subagent_inbox (subagent_id, text) values (${pre.id}, ${opts.text})`;
      const note = oneLine(`next: ${opts.note || deriveSteerNote(opts.text)}`, 80);
      const [run] = await tx<{ id: number; cardId: number | null }[]>`
        update runs set steer_notes = steer_notes || ${sql.json([note])}::jsonb
        where id = (select id from runs where subagent_id = ${pre.id} and status in ('queued', 'running') order by id desc limit 1)
        returning id, card_id`;
      return { mode: 'steered' as const, runId: Number(run?.id ?? 0), cardId: run?.cardId ? Number(run.cardId) : null, note, queued: true };
    });
    if (!res) throw new ToolError(`Coding agent ${pre.id} just finished. Send the message again to start a follow-up run.`);
    await appendEvent(opts.threadId, 'steer', opts.speakerId, { subagentId: pre.id, runId: res.runId, note: res.note, text: opts.text, kind: 'cursor', queued: true });
    await scheduleCardRender(res.cardId);
    return res;
  }
  if (pre.status !== 'idle') throw new ToolError(`Coding agent ${pre.id} is ${pre.status}. Start a new one with spawn_coding_agent.`);
  const agentId = pre.cursorAgentId;
  if (!agentId) throw new ToolError(`Coding agent ${pre.id} has no Cursor agent. Start a new one with spawn_coding_agent.`);
  const limited = await takeLimit('subagent', opts.speakerId, opts.threadId);
  if (limited) throw new ToolError(limited);
  if ((await activeCodingRuns()) >= limits.cursorMaxActive) throw new ToolError(`${limits.cursorMaxActive} coding agents are already running. Try again later.`);
  const cardId = await ensureTurnCard({ threadId: opts.threadId, turnId: opts.turnId });
  const runId = await sql.begin(async (tx) => {
    const [sa] = await tx<{ status: string }[]>`select status from subagents where id = ${pre.id} for update`;
    if (sa?.status !== 'idle') return null;
    const [last] = await tx<{ model: string | null }[]>`select model from runs where subagent_id = ${pre.id} order by id desc limit 1`;
    const [run] = await tx<{ id: number }[]>`
      insert into runs (subagent_id, thread_id, card_id, turn_id, instructions, is_resume, status, model, details, started_at, heartbeat_at)
      values (${pre.id}, ${opts.threadId}, ${cardId}, ${opts.turnId}, ${opts.text}, true, 'running', ${last?.model ?? 'cursor:default'},
              ${describeRunStatus('CREATING', 1)}, now(), now())
      returning id`;
    const id = Number(run!.id);
    await tx`insert into cursor_runs (run_id, agent_id, next_poll_at) values (${id}, ${agentId}, now() + ${limits.cursorPollMs / 1000} * interval '1 second')`;
    await tx`update subagents set status = 'running', last_active_at = now() where id = ${pre.id}`;
    return id;
  });
  if (runId == null) throw new ToolError(`Coding agent ${pre.id} is busy right now; try again in a moment.`);
  let run: CursorRun;
  try {
    run = await client().createRun(agentId, composeCursorFollowUp([opts.text], cfg));
  } catch (err) {
    await sql.begin(async (tx) => {
      await tx`delete from runs where id = ${runId}`;
      await tx`update subagents set status = 'idle' where id = ${pre.id} and status = 'running'`;
    });
    if (err instanceof CursorApiError && (err.code === 'agent_archived' || err.status === 404))
      throw new ToolError(`The Cursor session of ${pre.id} is gone (archived or expired). Start a new one with spawn_coding_agent.`);
    throw new ToolError(`Couldn't send the follow-up to Cursor: ${errText(err)}`);
  }
  const [prev] = await sql<{ prUrl: string | null }[]>`
    select c.pr_url from cursor_runs c join runs r on r.id = c.run_id where r.subagent_id = ${pre.id} and c.pr_url is not null order by c.run_id desc limit 1`;
  await sql`update cursor_runs set cursor_run_id = ${run.id}, cursor_status = ${run.status}, pr_url = ${prev?.prUrl ?? null} where run_id = ${runId}`;
  await setSources(runId, sourcesFor(pre.cursorAgentUrl, prev?.prUrl));
  await appendEvent(opts.threadId, 'resume', opts.speakerId, { subagentId: pre.id, runId, cardId, text: opts.text, kind: 'cursor', cursorRunId: run.id });
  await scheduleCardRender(cardId);
  return { mode: 'resumed', runId, cardId };
}

/** After cancel_subagent flagged a coding agent's run: stop the Cursor run right away (the poller is the backstop). */
export async function cancelCodingAgentNow(subagentId: string): Promise<void> {
  const rows = await sql<{ id: number }[]>`select id from runs where subagent_id = ${subagentId} and status = 'running' and cancel_requested`;
  for (const r of rows) {
    await sql`update cursor_runs set next_poll_at = now() where run_id = ${r.id}`;
    await pollCursorRuns({ runId: Number(r.id), max: 1 }).catch((err) => log.warn({ err: errText(err), runId: r.id }, 'immediate cursor cancel failed'));
  }
}

// ---------- polling ----------

interface Claimed {
  runId: number;
  agentId: string;
  cursorRunId: string | null;
  followUps: number;
  prUrl: string | null;
  pollErrors: number;
  inboxDefers: number;
  claimId: string;
  createdAt: Date;
  // from runs / subagents
  subagentId: string;
  threadId: string;
  cardId: number | null;
  cancelRequested: boolean;
  startedAt: Date | null;
  agentUrl: string | null;
}

const LEASE_S = limits.cursorPollLeaseMs / 1000;

/** Claim one due Cursor-backed run (or one whose lease ran out); `runId` restricts it to that run. */
export async function claimDueCursorRun(runId?: number): Promise<Claimed | null> {
  const only = runId != null ? sql`and c2.run_id = ${runId}` : sql``;
  const [c] = await sql<{ runId: number; agentId: string; cursorRunId: string | null; followUps: number; prUrl: string | null; pollErrors: number; inboxDefers: number; claimId: string; createdAt: Date }[]>`
    update cursor_runs c set claim_id = gen_random_uuid(), claimed_until = now() + ${LEASE_S} * interval '1 second', last_polled_at = now()
    where c.run_id = (
      select c2.run_id from cursor_runs c2 join runs r on r.id = c2.run_id
      where r.status = 'running' and c2.next_poll_at <= now() and (c2.claim_id is null or c2.claimed_until < now()) ${only}
      order by c2.next_poll_at limit 1 for update of c2 skip locked)
    returning c.run_id::int as run_id, c.agent_id, c.cursor_run_id, c.follow_ups, c.pr_url, c.poll_errors, c.inbox_defers, c.claim_id, c.created_at`;
  if (!c) return null;
  const [r] = await sql<{ subagentId: string; threadId: string; cardId: number | null; cancelRequested: boolean; startedAt: Date | null; agentUrl: string | null }[]>`
    select r.subagent_id, r.thread_id, r.card_id::int as card_id, r.cancel_requested, r.started_at, s.cursor_agent_url as agent_url
    from runs r join subagents s on s.id = r.subagent_id where r.id = ${c.runId}`;
  if (!r) return null;
  return { ...c, ...r };
}

/** Release our claim and schedule the next poll (only if we still hold it). */
async function release(c: Claimed, inMs: number, patch: { cursorStatus?: string; pollErrors?: number; inboxDefers?: number; lastError?: string | null } = {}) {
  await sql`
    update cursor_runs set claim_id = null, claimed_until = null,
      next_poll_at = now() + ${Math.max(0, inMs) / 1000} * interval '1 second',
      cursor_status = coalesce(${patch.cursorStatus ?? null}, cursor_status),
      poll_errors = coalesce(${patch.pollErrors ?? null}, poll_errors),
      inbox_defers = coalesce(${patch.inboxDefers ?? null}, inbox_defers),
      last_error = case when ${patch.lastError !== undefined} then ${patch.lastError ?? null} else last_error end
    where run_id = ${c.runId} and claim_id = ${c.claimId}`;
}

/** Finishing a run deferred this many times for steers that arrived meanwhile (`'inbox'`) ends it anyway. */
const MAX_INBOX_DEFERS = 3;

/**
 * Finish the bot run, atomically with a re-check that we still hold the claim (a poller whose lease ran out must not
 * finish a run another poller now handles). A `complete` that finds unseen steers (`'inbox'`) is normally deferred:
 * the next poll sends them as a follow-up. But never forever: a cancel request, or the defer count (kept in
 * cursor_runs.inbox_defers) reaching MAX_INBOX_DEFERS, finishes with the steers dropped.
 */
async function finish(c: Claimed, outcome: RunOutcome): Promise<'ok' | 'inbox' | 'gone'> {
  const run = { id: c.runId, subagentId: c.subagentId, threadId: c.threadId, cardId: c.cardId };
  const guard = async (tx: TransactionSql<{}>) =>
    (await tx`select 1 from cursor_runs where run_id = ${c.runId} and claim_id = ${c.claimId} for update`).length > 0;
  const defers = c.inboxDefers + 1;
  const dropInbox = c.cancelRequested || defers >= MAX_INBOX_DEFERS;
  const res = await finishRun(run, outcome, { guard, dropInbox });
  if (res === 'inbox') {
    // A steer arrived just now: the next poll sends it as a follow-up.
    await release(c, 0, { inboxDefers: defers });
    return res;
  }
  if (res === 'ok' && dropInbox && !c.cancelRequested) log.warn({ runId: c.runId }, 'cursor run finished with queued steers dropped (deferred too often)');
  await sql`update cursor_runs set claim_id = null, claimed_until = null where run_id = ${c.runId} and claim_id = ${c.claimId}`;
  return res;
}

/** Extend our lease before a slow step; false if the claim was lost (another poller has the run now). */
async function renewClaim(c: Claimed): Promise<boolean> {
  const rows = await sql`update cursor_runs set claimed_until = now() + ${LEASE_S} * interval '1 second' where run_id = ${c.runId} and claim_id = ${c.claimId} returning run_id`;
  return rows.length > 0;
}

const elapsedMs = (c: Claimed) => Date.now() - (c.startedAt?.getTime() ?? c.createdAt.getTime());
const timeoutText = () => `Timed out after ${Math.round(limits.cursorRunMaxMs / 3_600_000)}h (the Cursor run was cancelled)`;

async function onPollError(c: Claimed, err: unknown): Promise<void> {
  const e = err instanceof CursorApiError ? err : null;
  if (e && (e.status === 404 || e.code === 'agent_archived')) {
    await finish(c, { status: 'error', error: oneLine(`Cursor agent gone: ${e.message}`, 200) });
    return;
  }
  const errors = c.pollErrors + 1;
  if (errors >= limits.cursorMaxPollErrors || elapsedMs(c) > limits.cursorRunMaxMs) {
    await finish(c, { status: 'error', error: oneLine(`Lost contact with Cursor: ${errText(err)}`, 200) });
    return;
  }
  const backoff = Math.min(5 * 60_000, limits.cursorPollMs * 2 ** Math.min(errors - 1, 4));
  log.warn({ runId: c.runId, errors, err: errText(err) }, 'cursor poll failed');
  await release(c, Math.max(backoff, e?.retryAfterMs ?? 0), { pollErrors: errors, lastError: errText(err) });
}

/** Steers queued while the last Cursor run worked: take them (consumed now; given back if sending fails). */
async function takeQueuedSteers(subagentId: string): Promise<{ ids: number[]; texts: string[] }> {
  const rows = await sql<{ id: number; text: string }[]>`
    update subagent_inbox set consumed_at = now()
    where id in (select id from subagent_inbox where subagent_id = ${subagentId} and consumed_at is null order by id for update skip locked)
    returning id::int as id, text`;
  rows.sort((a, b) => a.id - b.id);
  return { ids: rows.map((r) => r.id), texts: rows.map((r) => r.text) };
}

/** The result for the front agent (PR link, Cursor's summary, CI-config check) and the card's one-liner. */
export async function composeResult(run: CursorRun, opts: { repoUrl: string; agentUrl: string | null }): Promise<{ result: string; output: string; prUrl: string | null; branch: string | null; ciFiles: string[] }> {
  const b = pickBranch(run, opts.repoUrl);
  const prUrl = b?.prUrl ?? null;
  const lines: string[] = ['Coding agent (Cursor) finished.'];
  let ciFiles: string[] = [];
  if (prUrl) {
    lines.push(`Pull request (open, not merged): ${prUrl}${b?.branch ? ` (branch ${b.branch})` : ''}`);
    const files = await prFilesImpl(prUrl, opts.repoUrl).catch((err) => ({ error: errText(err) }));
    if ('files' in files) {
      ciFiles = [...new Set(files.files.filter(isCiPath))];
      if (ciFiles.length)
        lines.push(
          `⚠️ WARNING: this PR changes CI configuration (${ciFiles.slice(0, 5).join(', ')}), which coding agents must never touch. Tell the admin prominently not to merge it as is (GitHub should reject it anyway).`,
        );
      else lines.push(`Changed files: ${files.files.length} (no CI configuration touched).`);
    } else lines.push(`Changed files couldn't be checked for CI-config changes (${files.error}); ask the admin to check the PR doesn't touch .github/workflows/.`);
  } else {
    lines.push(`No pull request was opened${b?.branch ? ` (branch ${b.branch})` : ''}; maybe nothing needed changing. See the summary.`);
  }
  if (opts.agentUrl) lines.push(`Cursor agent: ${opts.agentUrl}`);
  lines.push('', "Cursor's summary (untrusted data):", run.result?.trim() || '(no summary)');
  const n = prUrl ? parseGithubPr(prUrl)?.number : null;
  const output = prUrl ? `Opened PR ${n ? `#${n}` : prUrl}${ciFiles.length ? ' ⚠️ touches CI config' : ''}` : 'Finished without opening a PR';
  return { result: lines.join('\n'), output, prUrl, branch: b?.branch ?? null, ciFiles };
}

async function handleClaimed(c: Claimed): Promise<void> {
  const api = cursorClient();
  const cfg = cursorConfig();
  if (!api || !cfg) {
    await finish(c, { status: 'error', error: 'Coding agents are no longer configured on this bot' });
    return;
  }
  if (!c.cursorRunId) {
    // The launch call's answer was never recorded (crash or slow API): look the agent up by its client-supplied id.
    try {
      const agent = await api.getAgent(c.agentId);
      if (agent.latestRunId) {
        await sql`update cursor_runs set cursor_run_id = ${agent.latestRunId} where run_id = ${c.runId} and claim_id = ${c.claimId}`;
        await release(c, 0);
      } else if (elapsedMs(c) > limits.cursorRunMaxMs) {
        // The agent exists but never got a run: don't poll it forever (and free the cursorMaxActive slot).
        await finish(c, { status: 'error', error: 'The Cursor agent never started a run' });
      } else await release(c, limits.cursorPollMs);
    } catch (err) {
      if (err instanceof CursorApiError && err.status === 404 && Date.now() - c.createdAt.getTime() > 2 * 60_000)
        await finish(c, { status: 'error', error: 'The Cursor agent never started' });
      else if (err instanceof CursorApiError && err.status === 404) await release(c, limits.cursorPollMs);
      else await onPollError(c, err);
    }
    return;
  }

  let run: CursorRun;
  try {
    run = await api.getRun(c.agentId, c.cursorRunId);
  } catch (err) {
    await onPollError(c, err);
    return;
  }

  if (isRunActive(run.status)) {
    const timedOut = elapsedMs(c) > limits.cursorRunMaxMs;
    if (c.cancelRequested || timedOut) {
      try {
        await api.cancelRun(c.agentId, run.id);
      } catch (err) {
        if (!(err instanceof CursorApiError && err.code === 'run_not_cancellable')) {
          await onPollError(c, err);
          return;
        }
      }
      await finish(c, timedOut && !c.cancelRequested ? { status: 'error', error: timeoutText() } : { status: 'cancelled' });
      return;
    }
    // Progress: status line on the card (the plan row shows the elapsed time), PR link as soon as one exists.
    const b = pickBranch(run, cfg.repoUrl);
    const prUrl = b?.prUrl ?? c.prUrl;
    await sql`update runs set details = ${describeRunStatus(run.status, c.followUps)}, heartbeat_at = now() where id = ${c.runId} and status = 'running'`;
    if (prUrl && prUrl !== c.prUrl) {
      await sql`update cursor_runs set pr_url = ${prUrl}, branch = ${b?.branch ?? null} where run_id = ${c.runId}`;
      await setSources(c.runId, sourcesFor(c.agentUrl, prUrl));
    }
    await scheduleCardRender(c.cardId);
    await release(c, limits.cursorPollMs, { cursorStatus: run.status, pollErrors: 0, lastError: null });
    return;
  }

  // Terminal. A finished run with steers queued meanwhile continues with a follow-up run instead of ending.
  if (run.status === 'FINISHED' && !c.cancelRequested) {
    const steers = await takeQueuedSteers(c.subagentId);
    if (steers.texts.length) {
      // Our lease must outlast the call, and a poller that lost its claim must not send anything.
      if (!(await renewClaim(c))) {
        await sql`update subagent_inbox set consumed_at = null where id = any(${steers.ids}::bigint[])`;
        return;
      }
      try {
        const next = await api.createRun(c.agentId, composeCursorFollowUp(steers.texts, cfg));
        await sql`update cursor_runs set cursor_run_id = ${next.id}, cursor_status = ${next.status}, follow_ups = follow_ups + 1, inbox_defers = 0
                  where run_id = ${c.runId} and claim_id = ${c.claimId}`;
        await sql`update runs set details = ${describeRunStatus('CREATING', c.followUps + 1)}, heartbeat_at = now() where id = ${c.runId} and status = 'running'`;
        await appendEvent(c.threadId, 'cursor_follow_up', `subagent:${c.subagentId}`, { runId: c.runId, cursorRunId: next.id, messages: steers.texts.length });
        await scheduleCardRender(c.cardId);
        await release(c, limits.cursorPollMs, { cursorStatus: next.status, pollErrors: 0, lastError: null });
        return;
      } catch (err) {
        if (err instanceof CursorApiError && (err.transient || err.code === 'agent_busy')) {
          await sql`update subagent_inbox set consumed_at = null where id = any(${steers.ids}::bigint[])`;
          await onPollError(c, err);
          return;
        }
        // Can't continue (archived, rejected…): report what we have, and that the follow-up wasn't delivered.
        const r = await composeResult(run, { repoUrl: cfg.repoUrl, agentUrl: c.agentUrl });
        await recordPr(c, r.prUrl, r.branch);
        await finish(c, { status: 'complete', result: `${r.result}\n\nNote: the queued follow-up could not be sent to Cursor (${errText(err)}).`, output: r.output });
        return;
      }
    }
  }

  // Composing the result reads the PR's files from GitHub (slow): make sure we still hold the run.
  if (!(await renewClaim(c))) return;
  switch (run.status) {
    case 'FINISHED': {
      const r = await composeResult(run, { repoUrl: cfg.repoUrl, agentUrl: c.agentUrl });
      await recordPr(c, r.prUrl, r.branch);
      if (r.ciFiles.length) log.warn({ runId: c.runId, prUrl: r.prUrl, ciFiles: r.ciFiles }, 'coding agent PR touches CI configuration');
      await finish(c, { status: 'complete', result: r.result, output: r.output });
      return;
    }
    case 'CANCELLED':
      await finish(c, c.cancelRequested ? { status: 'cancelled' } : { status: 'error', error: 'Cancelled in Cursor' });
      return;
    default: {
      // ERROR / EXPIRED (or a status this code doesn't know yet).
      const detail = run.result?.trim() ? `: ${run.result.trim()}` : '';
      await finish(c, { status: 'error', error: oneLine(`Cursor run ${String(run.status).toLowerCase()}${detail}`, 300) });
    }
  }
}

async function recordPr(c: Claimed, prUrl: string | null, branch: string | null) {
  await sql`update cursor_runs set pr_url = coalesce(${prUrl}, pr_url), branch = coalesce(${branch}, branch) where run_id = ${c.runId}`;
  if (prUrl) await setSources(c.runId, sourcesFor(c.agentUrl, prUrl));
}

/** Maintenance task: poll every due Cursor-backed run, one claim at a time, within a time budget. */
export async function pollCursorRuns(opts: { max?: number; budgetMs?: number; runId?: number } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 25_000);
  let n = 0;
  while (n < (opts.max ?? 20) && Date.now() < deadline) {
    const c = await claimDueCursorRun(opts.runId);
    if (!c) break;
    n++;
    try {
      await handleClaimed(c);
    } catch (err) {
      log.error({ err, runId: c.runId }, 'cursor poll handling failed');
      await release(c, limits.cursorPollMs).catch(() => {});
    }
  }
  return n;
}
