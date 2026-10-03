import { z } from 'zod';

const Env = z.object({
  OPENROUTER_KEY: z.string().min(1),
  DATABASE_URL: z.string().default('postgres://smasnug:smasnug@localhost:5433/smasnug'),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_USER_TOKEN: z.string().optional(),
  MOD_CHANNEL_ID: z.string().optional(),
  ADMIN_USER_ID: z.string().optional(),
  SEMOJI_URL: z.string().default('https://emojis.raygen.dev'),
  SEMOJI_KEY: z.string().optional(),
  /** Exa search API key for `web_search` (src/tools/web-search.ts). Unset → the tool says web search isn't configured. */
  EXA_API_KEY: z.string().optional(),
  MODEL_LUNA: z.string().default('openai/gpt-6-luna'),
  /** Relevance gate: a decisions model on OpenRouter's Decisions API, or 'luna' to use the chat model. */
  GATE_MODEL: z.string().default('typesafe/jev-1.13'),
  /** Respond when the gate model's probability is at least this. */
  GATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  BOT_DISPLAY_NAME: z.string().default('smasnug ai'),
  LOG_LEVEL: z.string().default('info'),
  /** Turn status text: see src/pipeline/session-status.ts (overlay = native processing + activity text). */
  STATUS_ACTIVITY_MODE: z.enum(['overlay', 'text', 'off']).default('overlay'),
  /** Front agent reasoning effort on OpenRouter (see docs/perf.md for the latency/quality comparison). */
  FRONT_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium']).default('none'),
  /**
   * Reasoning effort for subagent runs; `default` = the model's own default. `low` roughly halves research runs
   * (docs/perf.md).
   */
  CHILD_REASONING_EFFORT: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high']).default('low'),
});

export const env = Env.parse(process.env);

/** Tunables from the design doc. Values marked TBD in the doc are best guesses. */
export const limits = {
  debounceIdleMs: 1000,
  /** DMs / mentions / two-party follow-ups (no gate): short window, see debounceWindowMs. */
  debounceDirectMs: 300,
  debounceBusyMs: 3000,
  contextReplies: 29,
  contextChannelMessages: 5,
  messageTruncateTokens: 300,
  disengageAfterMessages: 10,
  disengageAfterMs: 3 * 60 * 60 * 1000,
  gateContextMessages: 6,
  subagentIdleExpiryMs: 24 * 60 * 60 * 1000,
  heartbeatMs: 10_000,
  staleHeartbeatMs: 45_000,
  cardCoalesceMs: 1500,
  cardTitleMaxChars: 40,
  pendingSendTtlMs: 5 * 60 * 1000,
  memoryExtractIdleMs: 30 * 60 * 1000,
  memoryFactExpiryMs: 180 * 24 * 60 * 60 * 1000,
  memoryInjectCap: 20,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  // per user
  userMessagesPerHour: 500,
  userConcurrentSubagents: 10,
  userSlackSearchesPerHour: 500,
  userWebSearchesPerHour: 100,
  userFetchesPerHour: 100,
  userSendsPerHour: 100,
  // per thread / run
  threadConcurrentSubagents: 10,
  runMaxDurationMs: 10 * 60 * 1000,
  runMaxTokens: 400_000,
  autoSuspendReporters: 3,
  fetchMaxBytes: 3 * 1024 * 1024,
  fetchTimeoutMs: 10_000,
  webSearchDefaultResults: 5,
  webSearchMaxResults: 10,
  webSearchTimeoutMs: 10_000,
} as const;
