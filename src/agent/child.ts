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
import { SLACK_WAIT_EXTRA } from '../tools/slack-search.js';
import type { SlackWaitEvent } from '../core/slack.js';
import { addSource, compactHistory, describeToolStep, oneLine, splitResult, urlsInText, type RunSource } from './util.js';
import { onSandboxRunFinished } from '../sandbox/hooks.js';
import { sandboxChildPrompt } from '../sandbox/prompts.js';
import { previewsConfigured, SANDBOX_TOOL_NAMES, sandboxConfigured } from '../sandbox/settings.js';

/** Step cap per run (the token cap applies too). */
const MAX_STEPS = 50;
/**
 * This long before the run's time cap, the run is told to stop researching and report: a timed-out run fails with no
 * result at all, so deep research that runs long still hands back what it found.
 */
export const WRAP_UP_BEFORE_TIMEOUT_MS = 90_000;

/** Card text while the first step runs (until its first tool call). */
export const FIRST_STEP_DETAILS = 'Researching…';
/** A step running longer than this shows its elapsed time on the card, refreshed at this interval. */
export const ELAPSED_TICK_MS = 15_000;

/** Card text while the model works between tool calls (the step's tools have all returned). */
export const THINKING_DETAILS = 'Thinking…';
/** Card text while the model writes its final answer (text, no tool call in the step). */
export const WRITING_DETAILS = 'Writing up…';
/** Text shorter than this at the start of a step may be a preamble before tool calls: no "Writing up…" yet. */
const WRITING_MIN_CHARS = 40;

/**
 * The card label as a step streams: a tool's label while it runs (the latest call's), "Thinking…" once every tool
 * call of the step has returned (the model is generating again, so the tool's elapsed ticker must not keep running),
 * and "Writing up…" once the model streams answer text in a step without tool calls. Methods return the new label,
 * or null for no change. Pure.
 */
export class RunLabel {
  private open = new Set<string>();
  private toolCalls = 0;
  private writing = false;

  stepStart(): void {
    this.open.clear();
    this.toolCalls = 0;
    this.writing = false;
  }

  toolCall(callId: string, label: string): string {
    this.open.add(callId);
    this.toolCalls++;
    return label;
  }

  toolDone(callId: string): string | null {
    if (!this.open.delete(callId)) return null;
    return this.open.size ? null : THINKING_DETAILS;
  }

  /** `stepText`: the step's text so far. */
  text(stepText: string): string | null {
    if (this.writing || this.toolCalls || stepText.trim().length < WRITING_MIN_CHARS) return null;
    this.writing = true;
    return WRITING_DETAILS;
  }
}

/** "Searching the web for “x”" + 45s → "Searching the web for “x” (45s)". */
export function withElapsed(details: string, ms: number): string {
  return `${details} (${Math.round(ms / 1000)}s)`;
}

/** Card label while a tool's Slack call waits for the shared rate limiter (search: its own, tighter limit). */
export const SLACK_WAIT_LABEL = "Waiting for Slack's search rate limit";
const SLACK_WAIT_PREFIX = "Waiting for Slack's";
/** Shorter waits don't change the label (no flicker). */
const SLACK_WAIT_LABEL_MIN_MS = 1000;
export const slackWaitLabel = (ms: number, method = 'search.messages') =>
  `${method === 'search.messages' ? SLACK_WAIT_LABEL : "Waiting for Slack's rate limit"} (${Math.max(1, Math.ceil(ms / 1000))}s)`;
/** While a wait lasts, its label counts down this often. */
export const SLACK_WAIT_TICK_MS = 5000;

/**
 * The card label while a run's tool calls wait for Slack's rate limiter (pure logic). The wait label wins over tool
 * labels until every wait is over (parallel tool calls in one step would otherwise overwrite it as their tool-call
 * parts arrive); those labels are kept and the latest one comes back when the waits end. Counts down to the latest
 * expected end; names the search limit while any search waits.
 */
export class SlackWaitTracker {
  private waits = 0;
  private until = 0;
  private search = false;
  private before = '';

  get waiting(): boolean {
    return this.waits > 0;
  }

  /** A wait started (`current` = the label shown now): the label to show. */
  start(ev: Pick<SlackWaitEvent, 'method' | 'estimateMs'>, current: string, now = Date.now()): string {
    if (this.waits++ === 0) {
      this.before = current;
      this.until = 0;
      this.search = false;
    }
    this.until = Math.max(this.until, now + ev.estimateMs);
    if (ev.method === 'search.messages') this.search = true;
    return this.label(now)!;
  }

  /** A wait ended: the label to restore once none is left, else null. */
  end(): string | null {
    if (this.waits === 0) return null;
    return --this.waits === 0 ? this.before : null;
  }

  /** Another label (a tool call) while waiting: kept for after the wait (true), or shown now (false). */
  defer(details: string): boolean {
    if (!this.waits) return false;
    this.before = details;
    return true;
  }

  /** The countdown label now (null when nothing waits). */
  label(now = Date.now()): string | null {
    if (!this.waits) return null;
    return slackWaitLabel(this.until - now, this.search ? 'search.messages' : 'other');
  }
}

/** Runs executing in this process, for shutdown. */
const active = new Map<number, AbortController>();

class RunAbort extends Error {
  constructor(readonly kind: 'timeout' | 'shutdown' | 'gone' | 'cancel') {
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
  // Code sandbox subagents (src/sandbox/) get the longer run cap: builds and analyses take a while.
  const sandbox = !!sa.sandbox && sandboxConfigured();
  const maxDurationMs = sandbox ? limits.sandboxRunMaxDurationMs : limits.runMaxDurationMs;
  const timeout = setTimeout(() => controller.abort(new RunAbort('timeout')), maxDurationMs);
  const wrapUpAt = Date.now() + maxDurationMs - WRAP_UP_BEFORE_TIMEOUT_MS;
  let cancelRequested = false;
  const heartbeat = setInterval(() => {
    sql<{ cancelRequested: boolean }[]>`update runs set heartbeat_at = now() where id = ${run.id} and status = 'running' returning cancel_requested`
      .then((rows) => {
        if (rows.length === 0) controller.abort(new RunAbort('gone'));
        else if (rows[0]!.cancelRequested) {
          // Cancel mid-step: abort the model call and the tools in flight (tools refuse to start once aborted).
          cancelRequested = true;
          controller.abort(new RunAbort('cancel'));
        }
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
    extras: { [SLACK_WAIT_EXTRA]: (ev: SlackWaitEvent) => onSlackWait(ev) },
  });
  if (!sandbox) for (const name of SANDBOX_TOOL_NAMES) delete tools[name];
  const instructions = sandbox ? `${childSystemPrompt()}\n\n${sandboxChildPrompt({ previews: previewsConfigured() })}` : childSystemPrompt();
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

  const label = new RunLabel();
  // A Slack call waiting for the shared rate limiter (subagent searches can wait about one 30-s search window) shows
  // that on the card with a countdown, instead of a search that looks stuck; then the label goes back to what it
  // was (or the latest tool label that arrived meanwhile). Waits are added up per step for run_step.
  const waitLabel = new SlackWaitTracker();
  let waitTicker: NodeJS.Timeout | undefined;
  let stepSlackWaitMs = 0;
  let detailsSince = Date.now();
  /** Just the card text (no run_progress event): wait countdowns, restores, elapsed time. */
  const showDetails = (details: string, what: string) =>
    sql`update runs set details = ${details} where id = ${run.id} and status = 'running'`
      .then(() => scheduleCardRender(run.cardId))
      .catch((err) => log.debug({ err, runId: run.id }, `${what} failed`));
  const setDetails = async (details: string) => {
    if (!details.startsWith(SLACK_WAIT_PREFIX) && waitLabel.defer(details)) return;
    if (details === lastDetails) return;
    lastDetails = details;
    detailsSince = Date.now();
    await sql`update runs set details = ${details} where id = ${run.id} and status = 'running'`;
    await scheduleCardRender(run.cardId);
    if (details !== FIRST_STEP_DETAILS && details !== THINKING_DETAILS && details !== WRITING_DETAILS) {
      await appendEvent(run.threadId, 'run_progress', `subagent:${run.subagentId}`, { runId: run.id, details });
    }
  };
  const stopWaitTicker = () => {
    if (waitTicker) clearInterval(waitTicker);
    waitTicker = undefined;
  };
  const onSlackWait = (ev: SlackWaitEvent) => {
    if (ev.done) stepSlackWaitMs += ev.waitedMs;
    if (ev.estimateMs < SLACK_WAIT_LABEL_MIN_MS) return;
    if (!ev.done) {
      void setDetails(waitLabel.start(ev, lastDetails)).catch((err) => log.debug({ err, runId: run.id }, 'wait label failed'));
      waitTicker ??= setInterval(() => {
        const next = waitLabel.label();
        if (!next || next === lastDetails) return;
        lastDetails = next;
        void showDetails(next, 'wait countdown');
      }, SLACK_WAIT_TICK_MS);
      waitTicker.unref();
      return;
    }
    const restore = waitLabel.end();
    if (restore === null) return;
    stopWaitTicker();
    if (restore === lastDetails) return;
    lastDetails = restore;
    detailsSince = Date.now();
    void showDetails(restore, 'wait label restore');
  };
  // Long steps (deep web searches, long generations) produce no events: show the elapsed time instead of a
  // card that looks stuck. Goes through the coalesced card render, at most every ELAPSED_TICK_MS.
  const elapsedTicker = setInterval(() => {
    const ms = Date.now() - detailsSince;
    if (!lastDetails || ms < ELAPSED_TICK_MS || waitLabel.waiting) return;
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

      const overBudget = tokens >= limits.runMaxTokens || step >= MAX_STEPS || Date.now() >= wrapUpAt;
      if (overBudget) {
        messages.push({ role: 'user', content: '[Orchestrator update] You are out of time or budget for this task. Stop using tools and report what you have now (including the leads you didn\'t get to), ending with the SUMMARY line.' });
      }
      if (step === 0) await setDetails(FIRST_STEP_DETAILS);
      else if (!lastDetails || lastDetails === FIRST_STEP_DETAILS) await setDetails(THINKING_DETAILS);
      label.stepStart();
      const relabel = async (next: string | null) => {
        if (next) await setDetails(next);
      };

      const stepStart = Date.now();
      stepSlackWaitMs = 0;
      let firstChunkAt = 0;
      let stepTools: string[] = [];
      const result = streamText({
        model,
        instructions,
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
        if (part.type === 'text-delta') {
          stepText += part.text;
          await relabel(label.text(stepText));
        } else if (part.type === 'tool-call') {
          stepTools.push(part.toolName);
          if (part.toolName === 'fetch_url' && addSource(sources, (part.input as any)?.url)) sourcesDirty = true;
          await setDetails(label.toolCall(part.toolCallId, describeToolStep(part.toolName, part.input)));
        } else if (part.type === 'tool-result') {
          if (part.toolName === WEB_SEARCH_TOOL) for (const src of webSearchSources(part.output)) if (addSource(sources, src.url, src.title)) sourcesDirty = true;
          await relabel(label.toolDone(part.toolCallId));
        } else if (part.type === 'tool-error') await relabel(label.toolDone(part.toolCallId));
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
            ...(stepSlackWaitMs ? { slackWaitMs: stepSlackWaitMs } : {}),
            sources: sources.length,
            inputTokens: part.usage.inputTokens,
            outputTokens: part.usage.outputTokens,
            reasoningTokens: part.usage.outputTokenDetails?.reasoningTokens,
            cachedTokens: part.usage.inputTokenDetails?.cacheReadTokens,
          }).catch(() => {});
          void recordModelUsage({
            userId: sa.ownerId,
            threadId: run.threadId,
            model: modelId,
            inputTokens: part.usage.inputTokens,
            outputTokens: part.usage.outputTokens,
            cachedInputTokens: part.usage.inputTokenDetails?.cacheReadTokens,
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
        await finishRun(run, { status: 'error', error: `Timed out after ${Math.round(maxDurationMs / 60000)} min` }, { tokens, history: compactHistory(messages) });
      } else if (reason.kind === 'cancel') {
        await finishRun(run, { status: 'cancelled' }, { tokens, history: compactHistory(messages) });
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
    stopWaitTicker();
    active.delete(run.id);
    if (sandbox) void onSandboxRunFinished(run.id).catch((err) => log.warn({ err, runId: run.id }, 'sandbox run-finished hook failed'));
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
