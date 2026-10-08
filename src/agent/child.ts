/**
 * Subagent run processor (`subagent-run` jobs). One model step per loop iteration so the inbox is drained and the
 * cancel flag checked exactly at step boundaries (never mid tool call). Progress goes to `runs.details` and the
 * card is re-rendered (coalesced). History is persisted (compacted) at run end.
 */
import { streamText, stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { env, limits } from '../config.js';
import { sql } from '../db/index.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { toolsFor } from '../core/tools.js';
import { recordModelUsage } from '../features/guard.js';
import { chatModel, MODELS } from '../models.js';
import { log } from '../log.js';
import { WORKER_ID } from '../worker/identity.js';
import { scheduleCardRender } from './cards.js';
import { FIRST_STEP_DETAILS, THINKING_DETAILS, WRITING_DETAILS } from './card-render.js';
import { childSystemPrompt } from './prompts/child.js';
import { failRuns, finishRun, type RunRow, type SubagentRow } from './subagents.js';
import { WEB_SEARCH_TOOL, webSearchSources } from '../tools/web-search.js';
import { SEARCH_DEFER_EXTRA, SLACK_WAIT_EXTRA, type DeferFn } from '../tools/slack-search.js';
import { DeferredQueue } from './deferred.js';
import type { SlackWaitEvent } from '../core/slack.js';
import { addSource, compactHistory, describeToolStep, oneLine, splitResult, urlsInText, type RunSource } from './util.js';
import { onSandboxRunFinished } from '../sandbox/hooks.js';
import { resolveFile } from '../files/store.js';
import type { FileAccessContext } from '../files/access.js';
import { sandboxChildPrompt } from '../sandbox/prompts.js';
import { previewsConfigured, SANDBOX_TOOL_NAMES, sandboxConfigured } from '../sandbox/settings.js';

/** Step cap per run (the token cap applies too). */
const MAX_STEPS = 50;
/**
 * This long before the run's time cap, the run is told to stop researching and report: a timed-out run fails with no
 * result at all, so deep research that runs long still hands back what it found.
 */
export const WRAP_UP_BEFORE_TIMEOUT_MS = 90_000;

/**
 * Card text while the first step runs (until its first tool call) / while the model works between tool calls (the
 * step's tools have all returned) / while it writes its final answer (text, no tool call in the step). Defined in
 * card-render.ts, which shows the run's title instead of these in the plan title.
 */
export { FIRST_STEP_DETAILS, THINKING_DETAILS, WRITING_DETAILS };
/** A step running longer than this shows its elapsed time on the card, refreshed at this interval. */
export const ELAPSED_TICK_MS = 15_000;

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

/** Tools whose card label names the file they open (by its name, never its id). */
const FILE_STEP_TOOLS = new Set(['read_file', 'ask_file']);

/**
 * The name of the file a read_file / ask_file call opens, for its card label: only a file the run may use (the same
 * access rule as the tools, so a probed id never shows a name); undefined otherwise or on any error.
 */
async function stepFileName(toolName: string, input: unknown, ctx: FileAccessContext): Promise<string | undefined> {
  const id = (input as { file_id?: unknown } | null)?.file_id;
  if (!FILE_STEP_TOOLS.has(toolName) || typeof id !== 'string' || !id.trim()) return undefined;
  const f = await resolveFile(id.trim(), ctx).catch(() => null);
  return f && !('error' in f) ? f.name : undefined;
}

/** Card label while a tool's Slack call waits for the shared rate limiter (search or any other method). */
export const SLACK_WAIT_LABEL = 'Waiting on Slack';
const SLACK_WAIT_PREFIX = SLACK_WAIT_LABEL;
/** Shorter waits don't change the label (no flicker). */
const SLACK_WAIT_LABEL_MIN_MS = 1000;
/** Card label while a run that wants to finish waits for its queued (background) Slack searches. */
export const QUEUED_SEARCHES_LABEL = 'Waiting for queued Slack searches';
/** wait_for_searches returns after this long at most (the model can call it again or carry on). */
const WAIT_FOR_SEARCHES_MAX_MS = 45_000;

/** First message of a block of background search results added to the run's conversation. */
export const BACKGROUND_RESULTS_HEADER = '[Background results] Slack searches you queued earlier have finished:';

export const slackWaitLabel = (ms: number) => `${SLACK_WAIT_LABEL} (${Math.max(1, Math.ceil(ms / 1000))}s)`;
/** While a wait lasts, its label counts down this often. */
export const SLACK_WAIT_TICK_MS = 5000;

/**
 * The card label while a run's tool calls wait for Slack's rate limiter (pure logic). The wait label wins over tool
 * labels until every wait is over (parallel tool calls in one step would otherwise overwrite it as their tool-call
 * parts arrive); those labels are kept and the latest one comes back when the waits end. Counts down to the latest
 * expected end.
 */
export class SlackWaitTracker {
  private waits = 0;
  private until = 0;
  private before = '';

  get waiting(): boolean {
    return this.waits > 0;
  }

  /** A wait started (`current` = the label shown now): the label to show. */
  start(ev: Pick<SlackWaitEvent, 'method' | 'estimateMs'>, current: string, now = Date.now()): string {
    if (this.waits++ === 0) {
      this.before = current;
      this.until = 0;
    }
    this.until = Math.max(this.until, now + ev.estimateMs);
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
    return slackWaitLabel(this.until - now);
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
  try {
    await runClaimed(run);
  } catch (err) {
    // Nothing runs this run any more (e.g. a write that kept failing). Finish it now: left 'running', its heartbeat
    // stops and the stale-run sweeper would fail it ~45 s later as "Worker stopped", although no worker stopped.
    log.error({ err, runId: run.id }, 'subagent run crashed');
    await failRuns({ runIds: [run.id] }, shortError(err));
  }
}

/**
 * Finish a run; if saving fails with its history (e.g. content Postgres rejects), save the outcome without it rather
 * than lose the result.
 */
async function finishSafely(run: RunRow, outcome: Parameters<typeof finishRun>[1], extra: Parameters<typeof finishRun>[2] & {}): ReturnType<typeof finishRun> {
  try {
    return await finishRun(run, outcome, extra);
  } catch (err) {
    if (!extra.history) throw err;
    log.error({ err, runId: run.id }, 'saving the run failed; saving it without its history');
    return finishRun(run, outcome, { ...extra, history: undefined });
  }
}

/** The claimed run's loop (processSubagentRun): returns once the run is finished (or handed back on shutdown). */
async function runClaimed(run: RunRow): Promise<void> {
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
  // Code sandbox subagents (src/sandbox/) get the longer run cap: builds and analyses take a while.
  const sandbox = !!sa.sandbox && sandboxConfigured();
  const maxDurationMs = sandbox ? limits.sandboxRunMaxDurationMs : limits.runMaxDurationMs;
  const wrapUpAt = Date.now() + maxDurationMs - WRAP_UP_BEFORE_TIMEOUT_MS;
  let cancelRequested = false;

  const { channelId, threadTs } = parseThreadId(run.threadId);
  // Slack searches that couldn't get a slot soon run here in the background (src/agent/deferred.ts); counted per step.
  const deferred = new DeferredQueue(limits.deferredSearchesPerRun, controller.signal);
  let stepDeferred = 0;
  const deferSearch: DeferFn = (job) => {
    const id = deferred.defer(job);
    if (id) stepDeferred++;
    return id;
  };
  const tools = toolsFor('child', {
    threadId: run.threadId,
    channelId,
    threadTs,
    speakerId: sa.ownerId,
    subagentId: sa.id,
    runId: run.id,
    abortSignal: controller.signal,
    // queueUserImage deliberately unset: Luna accepts images in tool results.
    extras: { [SLACK_WAIT_EXTRA]: (ev: SlackWaitEvent) => onSlackWait(ev), [SEARCH_DEFER_EXTRA]: deferSearch },
  });
  tools.wait_for_searches = tool({
    description:
      'Wait for your queued background Slack searches (slack_search said "Queued as background search …") and get their results. Only when nothing else is left to do meanwhile; results also arrive by themselves before later steps.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!deferred.outstanding) return 'No background searches are pending.';
      await deferred.waitAny(Math.max(0, Math.min(WAIT_FOR_SEARCHES_MAX_MS, wrapUpAt - Date.now())), controller.signal);
      const results = deferred.take();
      const still = deferred.pendingLabels();
      const rest = still.length ? `Still running: ${still.join(', ')}.` : '';
      return results ? [results, rest].filter(Boolean).join('\n\n') : `No results yet. ${rest} Carry on, or call wait_for_searches again.`;
    },
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

  // Timers and the shutdown registry start right before the try, so its finally always clears them.
  active.set(run.id, controller);
  const timeout = setTimeout(() => controller.abort(new RunAbort('timeout')), maxDurationMs);
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

  try {
    let finalText = '';
    for (let step = 0; ; step++) {
      if (await checkCancel()) {
        await finishSafely(run, { status: 'cancelled' }, { tokens, history: compactHistory(messages) });
        return;
      }
      const inbox = await drainSubagentInbox(sa.id);
      for (const text of inbox) messages.push({ role: 'user', content: `[Orchestrator update] ${text}` });
      const background = deferred.take();
      if (background) messages.push({ role: 'user', content: `${BACKGROUND_RESULTS_HEADER}\n\n${background}` });

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
      stepDeferred = 0;
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
          const fileName = await stepFileName(part.toolName, part.input, { threadId: run.threadId, speakerId: sa.ownerId });
          await setDetails(label.toolCall(part.toolCallId, describeToolStep(part.toolName, part.input, { fileName })));
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
            ...(stepDeferred ? { deferredSearches: stepDeferred } : {}),
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

      // About to finish with queued searches outstanding: wait for them and have the report written with them.
      if (!overBudget && deferred.outstanding) {
        const waitStart = Date.now();
        await setDetails(QUEUED_SEARCHES_LABEL);
        // Never past the wrap-up point: a run that times out hands back nothing.
        await deferred.waitAll(Math.max(0, wrapUpAt - Date.now()), controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('aborted');
        const late = deferred.take();
        void appendEvent(run.threadId, 'run_bg_wait', `subagent:${run.subagentId}`, { runId: run.id, step, ms: Date.now() - waitStart, delivered: !!late }).catch(() => {});
        if (late) {
          messages.push({
            role: 'user',
            content: `${BACKGROUND_RESULTS_HEADER}\n\n${late}\n\n[Orchestrator update] These arrived after you wrote the report above, so it isn't final yet: take them into account (follow strong new leads if needed), then write the complete final report again, ending with the SUMMARY line.`,
          });
          continue;
        }
      }

      finalText = stepText;
      // No citations / fetches recorded: fall back to the URLs the result itself cites.
      if (sources.length === 0) {
        for (const u of urlsInText(finalText)) if (addSource(sources, u)) sourcesDirty = true;
        await saveSources().catch((err) => log.warn({ err, runId: run.id }, 'saving run sources failed'));
      }
      const { result: full, output } = splitResult(finalText);
      const done = await finishSafely(
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
        await finishSafely(run, { status: 'error', error: `Timed out after ${Math.round(maxDurationMs / 60000)} min` }, { tokens, history: compactHistory(messages) });
      } else if (reason.kind === 'cancel') {
        await finishSafely(run, { status: 'cancelled' }, { tokens, history: compactHistory(messages) });
      }
      // shutdown: onShutdown marks it errored; gone: someone else finished it.
      return;
    }
    log.error({ err, runId: run.id }, 'subagent run failed');
    await finishSafely(run, { status: 'error', error: shortError(err) }, { tokens, history: compactHistory(messages) });
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    clearInterval(elapsedTicker);
    stopWaitTicker();
    deferred.close();
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
