/**
 * Subagent run processor (`subagent-run` jobs). One model step per loop iteration so the inbox is drained and the
 * cancel flag checked exactly at step boundaries (never mid tool call). Progress goes to `runs.details` and the
 * card is re-rendered (coalesced). History is persisted (compacted) at run end.
 */
import { streamText, stepCountIs, type ModelMessage, type UserContent } from 'ai';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { toolsFor } from '../core/tools.js';
import { recordModelUsage } from '../features/guard.js';
import { MODELS, openrouter } from '../models.js';
import { log } from '../log.js';
import { WORKER_ID } from '../worker/identity.js';
import { scheduleCardRender } from './cards.js';
import { childSystemPrompt } from './prompts/child.js';
import { failRuns, finishRun, type RunRow, type SubagentRow } from './subagents.js';
import type { QueuedImage } from './types.js';
import { compactHistory, describeToolStep, oneLine, splitResult } from './util.js';


const MAX_STEPS = 40;

/** Runs executing in this process, for shutdown. */
const active = new Map<number, AbortController>();

class RunAbort extends Error {
  constructor(readonly kind: 'timeout' | 'shutdown' | 'gone') {
    super(kind);
  }
}

export function imageMessage(images: QueuedImage[]): ModelMessage {
  const content: UserContent = [];
  for (const img of images) {
    content.push({ type: 'text', text: img.caption ? `[image loaded: ${img.caption}]` : '[image loaded]' });
    content.push({ type: 'image', image: img.data, mediaType: img.mediaType });
  }
  return { role: 'user', content };
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
  const queuedImages: QueuedImage[] = [];
  const tools = toolsFor('child', {
    threadId: run.threadId,
    channelId,
    threadTs,
    speakerId: sa.ownerId,
    subagentId: sa.id,
    runId: run.id,
    abortSignal: controller.signal,
    extras: { queueUserImage: (img: QueuedImage) => queuedImages.push(img) },
  });
  const modelId = run.model ?? MODELS.child;
  const model = openrouter(modelId);
  const history: ModelMessage[] = Array.isArray(sa.history) ? sa.history : [];
  const messages: ModelMessage[] = [
    ...history,
    { role: 'user', content: run.isResume ? `[Follow-up from orchestrator]\n${run.instructions}` : run.instructions },
  ];
  let tokens = 0;
  let lastDetails = '';

  const checkCancel = async () => {
    if (cancelRequested) return true;
    const [r] = await sql<{ cancelRequested: boolean }[]>`select cancel_requested from runs where id = ${run.id}`;
    cancelRequested = !!r?.cancelRequested;
    return cancelRequested;
  };

  const setDetails = async (details: string) => {
    if (details === lastDetails) return;
    lastDetails = details;
    await sql`update runs set details = ${details} where id = ${run.id} and status = 'running'`;
    await scheduleCardRender(run.cardId);
    if (details !== 'Starting' && details !== 'Thinking') {
      await appendEvent(run.threadId, 'run_progress', `subagent:${run.subagentId}`, { runId: run.id, details });
    }
  };

  try {
    let finalText = '';
    for (let step = 0; ; step++) {
      if (await checkCancel()) {
        await finishRun(run, { status: 'cancelled' }, { tokens, history: compactHistory(messages) });
        return;
      }
      const inbox = await drainSubagentInbox(sa.id);
      for (const text of inbox) messages.push({ role: 'user', content: `[Orchestrator update] ${text}` });
      if (queuedImages.length) messages.push(imageMessage(queuedImages.splice(0)));

      const overBudget = tokens >= limits.runMaxTokens || step >= MAX_STEPS;
      if (overBudget) {
        messages.push({ role: 'user', content: '[Orchestrator update] You are out of budget for this task. Stop using tools and report what you have now, ending with the SUMMARY line.' });
      }
      if (step === 0) await setDetails('Starting');
      else if (!lastDetails || lastDetails === 'Starting') await setDetails('Thinking');

      const result = streamText({
        model,
        instructions: childSystemPrompt(),
        messages,
        tools,
        activeTools: overBudget ? [] : undefined,
        stopWhen: stepCountIs(1),
        abortSignal: controller.signal,
        providerOptions: { openrouter: { usage: { include: true } } },
      });
      let stepText = '';
      let finishReason = '';
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') stepText += part.text;
        else if (part.type === 'tool-call') await setDetails(describeToolStep(part.toolName, part.input));
        else if (part.type === 'finish-step') {
          finishReason = part.finishReason;
          tokens += part.usage.totalTokens ?? (part.usage.inputTokens ?? 0) + (part.usage.outputTokens ?? 0);
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
      if (finishReason === 'tool-calls' && !overBudget) continue;

      finalText = stepText;
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
