/**
 * Model traces for evals (docs/evals.md): what a front turn or subagent run saw and did, step by step. The loops feed
 * every stream part to a TraceRecorder (plus the notes they inject between steps) and save it once at the end.
 * Values are clipped, binary data (images in tool results) is dropped and the whole trace has a size budget
 * (TRACE_CLIP.total), so a trace stays around a megabyte at most. Strings are made safe for jsonb (no NUL, no lone
 * surrogates). Saving never throws into the loop; a trace is best-effort data.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { ModelMessage } from 'ai';
import { sql } from '../db/index.js';
import { log } from '../log.js';

export type TraceCall = { id: string; name: string; input: unknown; output?: string; error?: string; ms?: number };
export type TraceStep = {
  /** Notes / messages the loop added before this step (nudges, inbox messages, orchestrator updates). */
  notes?: string[];
  text?: string;
  reasoning?: string;
  calls: TraceCall[];
  finishReason?: string;
  /** The model that answered (chatModel may have fallen back to another provider / model). */
  model?: string;
  ms?: number;
  firstChunkMs?: number;
  usage?: { input?: number; output?: number; reasoning?: number; cached?: number };
};

export const TRACE_CLIP = {
  /** A tool result / error. */
  output: 6000,
  /** Any one string inside a tool input. */
  inputString: 4000,
  /** The step's text and reasoning. */
  text: 20_000,
  /** A note or one input message. */
  note: 8000,
  /** The turn message (thread context etc.). */
  input: 120_000,
  /** Object keys kept per object in a tool input / result. */
  keys: 100,
  /** Everything a recorder stores (text, reasoning, notes, inputs, results), in chars. */
  total: 1_000_000,
} as const;

/** jsonb rejects NUL and lone UTF-16 surrogates. */
export function safeStr(s: string): string {
  const out = s.includes('\u0000') ? s.replaceAll('\u0000', '') : s;
  return (out as any).toWellFormed ? (out as any).toWellFormed() : out;
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return safeStr(s);
  // Never cut a surrogate pair in half.
  const cut = max > 0 && /[\uD800-\uDBFF]/.test(s[max - 1]!) ? max - 1 : max;
  return safeStr(`${s.slice(0, cut)}… [${s.length - cut} more chars]`);
}

/** Long base64-looking runs (images, files) are never worth keeping. */
const BASE64_RUN = /[A-Za-z0-9+/=]{2000,}/g;

/** JSON-safe copy of a value with long strings clipped and binary data replaced. */
export function sanitize(value: unknown, maxString: number = TRACE_CLIP.inputString, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return clip(value.replace(BASE64_RUN, '[binary]'), maxString);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return '[binary]';
  if (value instanceof URL) return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return clip(value.message, maxString);
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitize(v, maxString, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, TRACE_CLIP.keys)) {
      const key = clip(k, 200);
      // Image / file parts: the bytes go, the media type stays.
      if ((k === 'data' || k === 'image') && typeof v === 'string' && v.length > 200) out[key] = '[binary]';
      else out[key] = sanitize(v, maxString, depth + 1);
    }
    if (entries.length > TRACE_CLIP.keys) out['…'] = `${entries.length - TRACE_CLIP.keys} more keys`;
    return out;
  }
  return String(value);
}

/** A tool result or message content as clipped text. */
export function asText(value: unknown, max: number): string {
  if (typeof value === 'string') return clip(value.replace(BASE64_RUN, '[binary]'), max);
  let s: string;
  try {
    s = JSON.stringify(sanitize(value, max));
  } catch {
    s = String(value);
  }
  return clip(s ?? '', max);
}

const BUDGET_NOTE = '[dropped: trace size budget]';

/** The messages a call starts from, clipped (the whole set within TRACE_CLIP.input). */
export function traceInput(messages: ModelMessage[]): { role: string; content: string }[] {
  let left: number = TRACE_CLIP.input;
  return messages.map((m) => {
    const content = asText(m.content, Math.max(500, left));
    left = Math.max(0, left - content.length);
    return { role: m.role, content };
  });
}

type Part = { type: string; [k: string]: any };

export class TraceRecorder {
  readonly steps: TraceStep[] = [];
  private cur: TraceStep | null = null;
  private pendingNotes: string[] = [];
  private stepStart = 0;
  private firstChunk = 0;
  private callStart = new Map<string, number>();
  /** Chars left in the trace's size budget. */
  private left: number;

  constructor(private readonly now: () => number = Date.now, budget: number = TRACE_CLIP.total) {
    this.left = budget;
  }

  /** Charge a stored string to the budget: clipped to what's left, a marker once it's spent. */
  private spend(s: string): string {
    if (s.length <= this.left) {
      this.left -= s.length;
      return s;
    }
    const kept = this.left > 200 ? clip(s, this.left - 100) : BUDGET_NOTE;
    this.left = 0;
    return kept;
  }

  /** Something the loop adds to the conversation before the next step. */
  note(content: unknown): void {
    this.pendingNotes.push(this.spend(asText(content, TRACE_CLIP.note)));
  }

  private step(): TraceStep {
    if (!this.cur) {
      this.cur = { calls: [] };
      if (this.pendingNotes.length) this.cur.notes = this.pendingNotes.splice(0);
      this.stepStart = this.now();
      this.firstChunk = 0;
    }
    return this.cur;
  }

  private call(id: string): TraceCall | undefined {
    return this.cur?.calls.find((c) => c.id === id) ?? this.steps.at(-1)?.calls.find((c) => c.id === id);
  }

  ingest(part: Part): void {
    try {
      this.ingestPart(part);
    } catch (err) {
      log.debug({ err }, 'trace ingest failed');
    }
  }

  private ingestPart(part: Part): void {
    switch (part.type) {
      case 'start-step':
        this.step();
        return;
      case 'text-delta': {
        const s = this.step();
        if (!this.firstChunk) this.firstChunk = this.now();
        if ((s.text?.length ?? 0) < TRACE_CLIP.text) s.text = (s.text ?? '') + (part.text ?? '');
        return;
      }
      case 'reasoning-delta': {
        const s = this.step();
        if (!this.firstChunk) this.firstChunk = this.now();
        if ((s.reasoning?.length ?? 0) < TRACE_CLIP.text) s.reasoning = (s.reasoning ?? '') + (part.text ?? '');
        return;
      }
      case 'tool-input-start':
        if (!this.firstChunk) this.firstChunk = this.now();
        return;
      case 'tool-call': {
        const s = this.step();
        if (!this.firstChunk) this.firstChunk = this.now();
        this.callStart.set(part.toolCallId, this.now());
        const input = sanitize(part.input);
        const size = JSON.stringify(input ?? null).length;
        s.calls.push({ id: part.toolCallId, name: part.toolName, input: size <= this.left ? input : this.spend(JSON.stringify(input)) });
        if (size <= this.left) this.left -= size;
        return;
      }
      case 'tool-result':
      case 'tool-error': {
        const c = this.call(part.toolCallId);
        if (!c) return;
        if (part.type === 'tool-result') c.output = this.spend(asText(part.output, TRACE_CLIP.output));
        else c.error = asText(part.error instanceof Error ? part.error.message : part.error, 1000);
        const started = this.callStart.get(part.toolCallId);
        if (started) c.ms = this.now() - started;
        return;
      }
      case 'finish-step': {
        const s = this.step();
        s.finishReason = part.finishReason;
        s.ms = this.now() - this.stepStart;
        if (this.firstChunk) s.firstChunkMs = this.firstChunk - this.stepStart;
        const u = part.usage ?? {};
        s.usage = { input: u.inputTokens, output: u.outputTokens, reasoning: u.outputTokenDetails?.reasoningTokens, cached: u.inputTokenDetails?.cacheReadTokens };
        if (typeof part.response?.modelId === 'string') s.model = part.response.modelId;
        this.settleText(s);
        this.steps.push(s);
        this.cur = null;
        return;
      }
      default:
        return;
    }
  }

  /** The finished steps, plus a step cut short by a stop/error (and notes that never reached a step). */
  finish(): TraceStep[] {
    if (this.cur) {
      this.cur.finishReason ??= 'interrupted';
      this.cur.ms ??= this.now() - this.stepStart;
      this.settleText(this.cur);
      this.steps.push(this.cur);
      this.cur = null;
    }
    if (this.pendingNotes.length) this.steps.push({ notes: this.pendingNotes.splice(0), calls: [] });
    return this.steps;
  }

  private settleText(s: TraceStep): void {
    if (s.text) s.text = this.spend(clip(s.text, TRACE_CLIP.text));
    if (s.reasoning) s.reasoning = this.spend(clip(s.reasoning, TRACE_CLIP.text));
  }
}

export function promptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

let gitShaCache: Promise<string | null> | undefined;
/** The running code's commit (GIT_SHA, else `git rev-parse` in the working directory, once per process). */
export function gitSha(): Promise<string | null> {
  gitShaCache ??= process.env.GIT_SHA
    ? Promise.resolve(process.env.GIT_SHA)
    : new Promise((resolve) => execFile('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000 }, (err, out) => resolve(err ? null : out.trim() || null)));
  return gitShaCache;
}

const knownPrompts = new Set<string>();

export type SaveTraceArgs = {
  threadId: string;
  kind: 'front' | 'run';
  turnId?: number | null;
  runId?: number | null;
  model: string;
  system: string;
  input: ModelMessage[];
  steps: TraceStep[];
  /** interrupted: the worker shut down, or another worker finished the run. */
  outcome: 'done' | 'stopped' | 'error' | 'cancelled' | 'timeout' | 'interrupted';
  error?: string | null;
  startedAt: Date;
};

/**
 * Store a trace (and its system prompt, once per version). Never throws. A message deleted in Slack while this turn
 * or run was in flight (applyDelete ran before this insert) drops the trace right away.
 */
export async function saveTrace(a: SaveTraceArgs): Promise<void> {
  try {
    const hash = promptHash(a.system);
    const channelId = a.threadId.split(':')[0]!;
    // The prompt row is re-upserted now and then, so a long-running process never points at one retention removed.
    if (!knownPrompts.has(hash) || Math.random() < 0.01) {
      await sql`insert into prompt_versions (hash, text) values (${hash}, ${safeStr(a.system)}) on conflict (hash) do update set created_at = now()`;
      knownPrompts.add(hash);
    }
    const [row] = await sql<{ id: number }[]>`
      insert into traces (thread_id, channel_id, kind, turn_id, run_id, model, prompt_hash, git_sha, input, steps, outcome, error, created_at, finished_at)
      values (${a.threadId}, ${channelId}, ${a.kind}, ${a.turnId ?? null}, ${a.runId ?? null}, ${a.model}, ${hash}, ${await gitSha()},
              ${sql.json(traceInput(a.input) as any)}, ${sql.json(a.steps as any)}, ${a.outcome}, ${a.error ? clip(a.error, 2000) : null},
              ${a.startedAt}, now())
      returning id`;
    await sql`
      delete from traces t where t.id = ${row!.id} and exists (
        select 1 from messages m where m.channel_id = ${channelId} and m.deleted and m.deleted_at >= t.created_at)`;
  } catch (err) {
    log.warn({ err, threadId: a.threadId, kind: a.kind }, 'saving trace failed');
  }
}
