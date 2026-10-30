/** A turn with everything the eval export knows about it (src/eval/load.ts builds it, detectors.ts scores it). */
import type { TraceStep } from '../agent/trace.js';

export type EvalTrace = {
  model: string | null;
  promptHash: string | null;
  gitSha: string | null;
  outcome: string | null;
  error: string | null;
  input: { role: string; content: string }[];
  steps: TraceStep[];
};

export type EvalEvent = { type: string; actor: string | null; payload: Record<string, any>; at: string };

export type EvalRun = {
  id: number;
  status: string;
  tokens: number;
  error: string | null;
  instructions: string;
  result: string | null;
  ms: number | null;
  /** run_step events (latency and usage per step), when there is no trace. */
  steps: Record<string, any>[];
  trace: EvalTrace | null;
};

export type EvalTurn = {
  turn: {
    id: number;
    threadId: string;
    kind: string;
    authorId: string;
    isMention: boolean;
    addressed: boolean;
    isDm: boolean;
    status: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  /** The messages that triggered the turn. */
  request: { userId: string | null; text: string }[];
  events: EvalEvent[];
  trace: EvalTrace | null;
  runs: EvalRun[];
  /** Human messages in the thread shortly after the turn (corrections, re-asks, thanks). */
  followUps: { userId: string | null; text: string; minutesAfter: number }[];
  /** Reactions on the bot's messages posted during the turn. */
  reactions: { name: string; count: number }[];
};

export type Flag = { code: string; weight: number; detail: string };

export type TurnStats = {
  steps: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  turnEndMs: number | null;
  firstTextMs: number | null;
  runs: number;
  runTokens: number;
  tools: string[];
  skills: string[];
};

export type ScoredTurn = EvalTurn & { flags: Flag[]; score: number; stats: TurnStats };
