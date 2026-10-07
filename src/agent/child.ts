/**
 * Subagent run processor (`subagent-run` jobs). One model step per loop iteration so the inbox is drained and the
 * cancel flag checked exactly at step boundaries (never mid tool call). Progress goes to `runs.details` and the
 * card is re-rendered (coalesced). History is persisted (compacted) at run end.
 */
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { env, limits } from '../config.js';
import { sql } from '../db/index.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { toolsFor } from '../core/tools.js';
import { recordModelUsage } from '../features/guard.js';
import { chatModel, MODELS } from '../models.js';
import { log } from '../log.js';
import { WORKER_ID } from '../worker/identity.js';
import { scheduleCardRender } from './cards.js';
import { childSystemPrompt } from './prompts/child.js';
import { failRuns, finishRun, type RunRow, type SubagentRow } from './subagents.js';
import { WEB_SEARCH_TOOL, webSearchSources } from '../tools/web-search.js';
import { addSource, compactHistory, describeToolStep, oneLine, splitResult, urlsInText, type RunSource } from './util.js';

/** Step cap per run (the token cap applies too). */
const MAX_STEPS = 50;

/** Card text while the first step runs (until its first tool call). */
export const FIRST_STEP_DETAILS = 'Researching…';
/** A step running longer than this shows its elapsed time on the card, refreshed at this interval. */
export const ELAPSED_TICK_MS = 15_000;

/** "Searching the web for “x”" + 45s → "Searching the web for “x” (45s)". */
export function withElapsed(details: string, ms: number): string {
  return `${details} (${Math.round(ms / 1000)}s)`;
}

/** Runs executing in this process, for shutdown. */
const active = new Map<number, AbortController>();

class RunAbort extends Error {
  constructor(readonly kind: 'timeout' | 'shutdown' | 'gone') {
    super(kind);
  }
}

async function drainSubagentInbox(subagentId: string): Promise<string[]> {
  const rows = await sql<{ text: string }[]>`
    update subagent_inbox set consumed_at = now()
    where id in (select id from subagent_inbox where subagent_id = ${subagentId} and consumed_at is null order by id for update skip locked)
    returning text, id`;
  return rows.map((r) => r.text);
}

export async function processSubagentRun(runId: number): Promise<void> {
  const [run] = await sql<RunRow[]>`
    update runs set status = 'running', started_at = now(), heartbeat_at = now(), worker_id = ${WORKER_ID}
    where id = ${runId} and status = 'queued' returning *`;
  if (!run) return; // already handled, cancelled while queued, or swept
  run.id = Number(run.id);
  run.cardId = run.cardId ? Number(run.cardId) : null;
  await appendEvent(run.threadId, 'run_started', `subagent:${run.subagentId}`, { runId: run.id });
  await scheduleCardRender(run.cardId);

  if (run.cancelRequested) {
    await finishRun(run, { status: 'cancelled' });
    return;
  }
  const [sa] = await sql<SubagentRow[]>`select * from subagents where id = ${run.subagentId}`;
  if (!sa) {
    await failRuns({ runIds: [run.id] }, 'Subagent missing');
    return;
  }

  const controller = new AbortController();
  active.set(run.id, controller);
  const timeout = setTimeout(() => controller.abort(new RunAbort('timeout')), limits.runMaxDurationMs);
  let cancelRequested = false;
  const heartbeat = setInterval(() => {
    sql<{ cancelRequested: boolean }[]>`update runs set heartbeat_at = now() where id = ${run.id} and status = 'running' returning cancel_requested`
      .then((rows) => {
        if (rows.length === 0) controller.abort(new RunAbort('gone'));
        else if (rows[0]!.cancelRequested) cancelRequested = true;
      })
      .catch((err) => log.warn({ err, runId: run.id }, 'heartbeat failed'));
  }, limits.heartbeatMs);

  const { channelId, threadTs } = parseThreadId(run.threadId);
  const tools = toolsFor('child', {
    threadId: run.threadId,
    channelId,
    threadTs,
    speakerId: sa.ownerId,
    subagentId: sa.id,
    runId: run.id,
    abortSignal: controller.signal,
    // queueUserImage deliberately unset: Luna accepts images in tool results.
    extras: {},
  });
  // Every subagent runs on MODELS.child (runs.model records it).
  const modelId = MODELS.child;
  const model = chatModel(modelId);
  const reasoningEffort = env.CHILD_REASONING_EFFORT !== 'default' ? env.CHILD_REASONING_EFFORT : null;
  const history: ModelMessage[] = Array.isArray(sa.history) ? sa.history : [];
  const messages: ModelMessage[] = [
    ...history,
    { role: 'user', content: run.isResume ? `[Follow-up from orchestrator]\n${run.instructions}` : run.instructions },
  ];
  let tokens = 0;
  let lastDetails = '';
  const sources: RunSource[] = Array.isArray(run.sources) ? [...run.sources] : [];
  let sourcesDirty = false;
  const saveSources = async () => {
    if (!sourcesDirty) return;
    sourcesDirty = false;
    await sql`update runs set sources = ${sql.json(sources as any)} where id = ${run.id} and status = 'running'`;
    await scheduleCardRender(run.cardId);
  };

  const checkCancel = async () => {
    if (cancelRequested) return true;
    const [r] = await sql<{ cancelRequested: boolean }[]>`select cancel_requested from runs where id = ${run.id}`;
    cancelRequested = !!r?.cancelRequested;
    return cancelRequested;
  };

  let detailsSince = Date.now();
  const setDetails = async (details: string) => {
    if (details === lastDetails) return;
    lastDetails = details;
    detailsSince = Date.now();
    await sql`update runs set details = ${details} where id = ${run.id} and status = 'running'`;
    await scheduleCardRender(run.cardId);
    if (details !== FIRST_STEP_DETAILS && details !== 'Thinking') {
      await appendEvent(run.threadId, 'run_progress', `subagent:${run.subagentId}`, { runId: run.id, details });
    }
  };
  // Long steps (deep web searches, long generations) produce no events: show the elapsed time instead of a
  // card that looks stuck. Goes through the coalesced card render, at most every ELAPSED_TICK_MS.
  const elapsedTicker = setInterval(() => {
    const ms = Date.now() - detailsSince;
    if (!lastDetails || ms < ELAPSED_TICK_MS) return;
    const shown = withElapsed(lastDetails, ms);
    sql`update runs set details = ${shown} where id = ${run.id} and status = 'running'`
      .then(() => scheduleCardRender(run.cardId))
      .catch((err) => log.debug({ err, runId: run.id }, 'elapsed update failed'));
  }, ELAPSED_TICK_MS);
  elapsedTicker.unref();

  try {
    let finalText = '';
    for (let step = 0; ; step++) {
      if (await checkCancel()) {
        await finishRun(run, { status: 'cancelled' }, { tokens, history: compactHistory(messages) });
        return;
      }
      const inbox = await drainSubagentInbox(sa.id);
      for (const text of inbox) messages.push({ role: 'user', content: `[Orchestrator update] ${text}` });

      const overBudget = tokens >= limits.runMaxTokens || step >= MAX_STEPS;
      if (overBudget) {
        messages.push({ role: 'user', content: '[Orchestrator update] You are out of budget for this task. Stop using tools and report what you have now, ending with the SUMMARY line.' });
      }
      if (step === 0) await setDetails(FIRST_STEP_DETAILS);
      else if (!lastDetails || lastDetails === FIRST_STEP_DETAILS) await setDetails('Thinking');

      const stepStart = Date.now();
      let firstChunkAt = 0;
      let stepTools: string[] = [];
      const result = streamText({
        model,
        instructions: childSystemPrompt(),
        messages,
        tools,
        activeTools: overBudget ? [] : undefined,
        stopWhen: stepCountIs(1),
        abortSignal: controller.signal,
        providerOptions: { openrouter: { ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}), usage: { include: true }, ...(overBudget ? {} : { parallel_tool_calls: true }) } },
      });
      let stepText = '';
      let finishReason = '';
      for await (const part of result.fullStream) {
        if (!firstChunkAt && part.type !== 'start' && part.type !== 'start-step') firstChunkAt = Date.now();
        if (part.type === 'text-delta') stepText += part.text;
        else if (part.type === 'tool-call') {
          stepTools.push(part.toolName);
          if (part.toolName === 'fetch_url' && addSource(sources, (part.input as any)?.url)) sourcesDirty = true;
          await setDetails(describeToolStep(part.toolName, part.input));
        } else if (part.type === 'tool-result' && part.toolName === WEB_SEARCH_TOOL) {
          for (const src of webSearchSources(part.output)) if (addSource(sources, src.url, src.title)) sourcesDirty = true;
        }
        else if (part.type === 'finish-step') {
          finishReason = part.finishReason;
          tokens += part.usage.totalTokens ?? (part.usage.inputTokens ?? 0) + (part.usage.outputTokens ?? 0);
          // Per-step latency (the card and `pnpm bench --child` read it).
          void appendEvent(run.threadId, 'run_step', `subagent:${run.subagentId}`, {
            runId: run.id,
            step,
            ms: Date.now() - stepStart,
            firstChunkMs: firstChunkAt ? firstChunkAt - stepStart : null,
            tools: stepTools,
            sources: sources.length,
            inputTokens: part.usage.inputTokens,
            outputTokens: part.usage.outputTokens,
            reasoningTokens: part.usage.outputTokenDetails?.reasoningTokens,
          }).catch(() => {});
          void recordModelUsage({
            userId: sa.ownerId,
            threadId: run.threadId,
            model: modelId,
            inputTokens: part.usage.inputTokens,
            outputTokens: part.usage.outputTokens,
          }).catch((err) => log.warn({ err }, 'recordModelUsage failed'));
        } else if (part.type === 'error') throw part.error;
        else if (part.type === 'abort') throw controller.signal.reason ?? new Error('aborted');
      }
      messages.push(...(await result.responseMessages));
      await saveSources().catch((err) => log.warn({ err, runId: run.id }, 'saving run sources failed'));
      if (finishReason === 'tool-calls' && !overBudget) continue;

      finalText = stepText;
      // No citations / fetches recorded: fall back to the URLs the result itself cites.
      if (sources.length === 0) {
        for (const u of urlsInText(finalText)) if (addSource(sources, u)) sourcesDirty = true;
        await saveSources().catch((err) => log.warn({ err, runId: run.id }, 'saving run sources failed'));
      }
      const { result: full, output } = splitResult(finalText);
      const done = await finishRun(
        run,
        { status: 'complete', result: full || '(no result text)', output },
        { tokens, history: compactHistory(messages) },
      );
      if (done === 'inbox') continue; // steer arrived just as it finished: take it into account
      return;
    }
  } catch (err) {
    const reason = controller.signal.aborted ? controller.signal.reason : err;
    if (reason instanceof RunAbort) {
      if (reason.kind === 'timeout') {
        await finishRun(run, { status: 'error', error: `Timed out after ${Math.round(limits.runMaxDurationMs / 60000)} min` }, { tokens, history: compactHistory(messages) });
      }
      // shutdown: onShutdown marks it errored; gone: someone else finished it.
      return;
    }
    log.error({ err, runId: run.id }, 'subagent run failed');
    await finishRun(run, { status: 'error', error: shortError(err) }, { tokens, history: compactHistory(messages) });
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    clearInterval(elapsedTicker);
    active.delete(run.id);
  }
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return oneLine(`Error: ${msg}`, 100);
}

/** On shutdown: stop local loops and mark this worker's in-flight runs errored (runs are never resumed). */
export async function shutdownRuns(): Promise<void> {
  for (const c of active.values()) c.abort(new RunAbort('shutdown'));
  const rows = await sql<{ id: number }[]>`select id from runs where worker_id = ${WORKER_ID} and status = 'running'`;
  await failRuns({ runIds: rows.map((r) => Number(r.id)) }, 'Worker stopped');
}
