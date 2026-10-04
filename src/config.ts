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
  /** Hack Club AI (OpenRouter proxy): primary chat provider when set, OpenRouter is the fallback (src/models.ts). */
  HACKCLUB_AI_KEY: z.string().optional(),
  HACKCLUB_AI_URL: z.string().default('https://ai.hackclub.com/proxy/v1'),
  MODEL_LUNA: z.string().default('openai/gpt-6-luna'),
  /** Relevance gate: a decisions model on OpenRouter's Decisions API, or 'luna' to use the chat model. */
  GATE_MODEL: z.string().default('typesafe/jev-1.13'),
  /** Respond when the gate model's probability is at least this. */
  GATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  BOT_DISPLAY_NAME: z.string().default('smasnug ai'),
  LOG_LEVEL: z.string().default('info'),
  /**
   * Turn activity text (src/agent/activity-trail.ts): `tasks` = transient task cards in the reply message, `off` =
   * Slack's "Working…" only. The old values `overlay` / `text` (deprecated assistant.threads.setStatus) mean `tasks`.
   */
  STATUS_ACTIVITY_MODE: z.preprocess((v) => (v === 'overlay' || v === 'text' ? 'tasks' : v), z.enum(['tasks', 'off'])).default('tasks'),
  /** Front agent reasoning effort on OpenRouter (see docs/perf.md for the latency/quality comparison). */
  FRONT_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium']).default('none'),
  /**
   * Reasoning effort for subagent runs; `default` = the model's own default. `low` roughly halves research runs
   * (docs/perf.md).
   */
  CHILD_REASONING_EFFORT: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high']).default('low'),
  /**
   * Coding agents (Cursor Cloud Agents, src/agent/cursor/): admin-only background agents that change the bot's own repo
   * and open a PR. Off unless both CURSOR_API_KEY and CURSOR_REPO are set. Never logged.
   */
  CURSOR_API_KEY: z.string().optional(),
  /** GitHub URL of the bot's repository, e.g. https://github.com/ingoau/smasnug-ai-v3. */
  CURSOR_REPO: z.string().optional(),
  /** Branch (or commit) the coding agent starts from; its PR targets this. */
  CURSOR_REF: z.string().default('main'),
  /** Cursor model id (GET /v1/models); unset = the Cursor account's default model. */
  CURSOR_MODEL: z.string().optional(),
  CURSOR_API_URL: z.string().default('https://api.cursor.com'),
  /** Optional read-only GitHub token: lets the post-run check list a private repo's PR files (public repos need none). */
  CURSOR_GITHUB_TOKEN: z.string().optional(),
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
  /** slack_semantic_search (Slack Real-time Search): secondary search, kept rare. */
  userSemanticSearchesPerHour: 20,
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
  // canvases (src/tools/canvases.ts)
  userCanvasReadsPerHour: 60,
  /** create_canvas + edit_canvas calls. */
  userCanvasWritesPerHour: 30,
  /** read_canvas returns at most this many chars per call (`offset` pages through the rest). */
  canvasReadMaxChars: 24_000,
  /** create_canvas / edit_canvas content cap (Slack allows 1 MiB per change). */
  canvasWriteMaxChars: 100_000,
  /** bot_canvases rows (what makes a canvas editable) are dropped after this long without use. */
  canvasRowExpiryMs: 180 * 24 * 60 * 60 * 1000,
  // reminders and watches (src/features/schedule)
  userPendingReminders: 20,
  reminderMaxAheadMs: 365 * 24 * 60 * 60 * 1000,
  reminderTextMaxChars: 1000,
  userActiveWatches: 5,
  watchDefaultIntervalMs: 6 * 60 * 60 * 1000,
  watchMinIntervalMs: 60 * 60 * 1000,
  watchMaxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  watchNotificationsPerDay: 3,
  scheduleTickMs: 60_000,
  // coding agents (Cursor, src/agent/cursor/)
  /** How often running Cursor agents are polled (maintenance task + per-run next_poll_at). */
  cursorPollMs: 30_000,
  /** A poller's lease on one Cursor run while it checks it (exactly-once handling across workers). */
  cursorPollLeaseMs: 2 * 60_000,
  /** Cursor runs get their own max duration (the subagent run limit / heartbeat sweeper don't apply). */
  cursorRunMaxMs: 3 * 60 * 60 * 1000,
  /** Coding agents running at once (all users; it's admin-only anyway). */
  cursorMaxActive: 3,
  cursorApiTimeoutMs: 20_000,
  /** Consecutive failed polls (backing off up to 5 min) before the run is marked failed. */
  cursorMaxPollErrors: 30,
} as const;
