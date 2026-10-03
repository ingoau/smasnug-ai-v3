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
  MODEL_LUNA: z.string().default('openai/gpt-6-luna'),
  MODEL_SOL: z.string().default('openai/gpt-6-sol'),
  BOT_DISPLAY_NAME: z.string().default('smasnug ai'),
  LOG_LEVEL: z.string().default('info'),
  /** Turn status text: see src/pipeline/session-status.ts (overlay = native processing + activity text). */
  STATUS_ACTIVITY_MODE: z.enum(['overlay', 'text', 'off']).default('overlay'),
});

export const env = Env.parse(process.env);

/** Tunables from the design doc. Values marked TBD in the doc are best guesses. */
export const limits = {
  debounceIdleMs: 1000,
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
  webSearchMaxResults: 4,
} as const;
