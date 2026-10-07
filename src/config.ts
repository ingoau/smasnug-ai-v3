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
  /**
   * HuddleFM DJ mode (src/features/huddlefm): the Slack user id of the HuddleFM bot user. The bot talks to it through
   * HuddleFM's bot API (JSON DMs); its own user id must be in HuddleFM's INTEGRATION_USER_IDS. Unset → no DJ tools.
   */
  HUDDLEFM_USER_ID: z.string().optional(),
});

export const env = Env.parse(process.env);

/** Tunables from the design doc. Values marked TBD in the doc are best guesses. */
export const limits = {
  debounceIdleMs: 1000,
  /** DMs / mentions / two-party follow-ups (no gate): short window, see debounceWindowMs. */
  debounceDirectMs: 300,
  debounceBusyMs: 3000,
  /** Thread history in the prompt: at most this many replies (plus the parent), within historyTokens (src/context/window.ts). */
  contextReplies: 40,
  historyTokens: 8000,
  /**
   * Rolling thread summary (src/context/summary.ts) of the replies older than the history window. Once the replies
   * after the summary use more than threadSummaryCompactAt of the history budget (size or count), a background job
   * folds the older ones in, leaving threadSummaryKeep of the budget shown.
   */
  threadSummaryCompactAt: 0.8,
  threadSummaryKeep: 0.5,
  /** Hard length cap of the summary (≈tokens): the model is asked for less, the stored text is cut at this. */
  threadSummaryMaxTokens: 800,
  /** Replies folded in per model call (≈tokens of rendered messages); more are done in several calls, oldest first. */
  threadSummaryChunkTokens: 30_000,
  /** Per-message cut (≈tokens) in the summariser's input. */
  threadSummaryMessageTokens: 1500,
  threadSummaryTimeoutMs: 90_000,
  contextChannelMessages: 5,
  /** Per-message cuts (≈tokens, ~4 chars each) when rendering Slack messages for a model, cut with " [truncated]". */
  /** Thread history in the prompt (the history section's own budget still drops the oldest messages first). */
  messageTruncateTokens: 1000,
  /** Channel background around the thread parent (a small section, so a long message can't crowd out the rest). */
  channelMessageTruncateTokens: 300,
  /** The turn's own new messages (and ones that arrive mid-turn): the request itself, e.g. a pasted log. */
  newMessageTruncateTokens: 4000,
  /** Explicit reads: read_thread, read_channel, read_public_thread, read_public_channel. */
  readMessageTruncateTokens: 2000,
  /** Page size cap (≈tokens) for read_thread / read_channel: a page stops before it would exceed this (≥ 1 message). */
  readPageTokens: 6000,
  /** ask_thread: per-message cut and the whole transcript's cap (≈tokens; over it: parent + newest messages). */
  askThreadMessageTokens: 4000,
  askThreadMaxTokens: 80_000,
  /** ask_thread: the answering model call's timeout. */
  askThreadTimeoutMs: 90_000,
  disengageAfterMessages: 25,
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
  /**
   * How often running Cursor agents are polled (maintenance task + per-run next_poll_at).
   * 10 s: under the Cloud Agents API default of 20 req/min per endpoint per key (each steady-state poll is one
   * getRun). At limits.cursorMaxActive (3) that is ~18 getRun/min — a little headroom for bursts (e.g. several runs
   * becoming due together, or an immediate cancel poll). 5 s would be ~36/min and hit 429s when several agents run.
   */
  cursorPollMs: 10_000,
  /** A poller's lease on one Cursor run while it checks it (exactly-once handling across workers); renewed before slow steps, well above the worst-case handling time (a few API calls with 20 s timeouts + GitHub). */
  cursorPollLeaseMs: 10 * 60_000,
  /** Cursor runs get their own max duration (the subagent run limit / heartbeat sweeper don't apply). */
  cursorRunMaxMs: 3 * 60 * 60 * 1000,
  /** Coding agents running at once (all users; it's admin-only anyway). */
  cursorMaxActive: 3,
  cursorApiTimeoutMs: 20_000,
  /** Consecutive failed polls (backing off up to 5 min) before the run is marked failed. */
  cursorMaxPollErrors: 30,
  /** How long the admin's Launch / Cancel confirmation for a new coding agent stays valid. */
  cursorConfirmTtlMs: 15 * 60_000,
  // HuddleFM DJ mode (src/features/huddlefm)
  /** How long a command waits for HuddleFM's threaded reply. */
  djReplyTimeoutMs: 20_000,
  /** request_control only answers right away on failure: silence for this long means it's waiting on the host. */
  djRequestGraceMs: 4_000,
  /** HuddleFM expires a pending request after 5 minutes, but stays silent if it restarted: drop ours after this. */
  djPendingTimeoutMs: 6 * 60_000,
  /** `huddle_dj` tool calls per user per hour. */
  userDjCommandsPerHour: 120,
  djMaxCommandsPerCall: 8,
  /** Songs per search/add batch, and skips per skip command. */
  djMaxBatch: 10,
  djMaxSkip: 10,
  /** Up-next entries kept in the playback snapshot shown to the agent. */
  djSnapshotQueue: 10,
  /** Events within this window collapse into one status sync / top-up. */
  djSyncDelayMs: 2_000,
  /** Auto DJ: top up when fewer than this many songs people (or the bot) queued are waiting. */
  djAutoMinQueue: 2,
  /** Auto DJ: songs added per top-up at most (fewer when the queue is near HuddleFM's limit). */
  djAutoBatch: 3,
  /** Auto DJ: candidates asked from the model per top-up beyond the room (misses and repeats get skipped). */
  djAutoExtraCandidates: 2,
  /** Auto DJ: wait after a top-up that added nothing, doubling per consecutive miss up to djAutoMaxBackoffMs. */
  djAutoBackoffMs: 60_000,
  djAutoMaxBackoffMs: 15 * 60_000,
  /** History kept per session (picks, requested, skipped, played). */
  djHistory: 40,
  /** Chatter: at most one line per this long. */
  djChatterCooldownMs: 4 * 60_000,
  /** Other notices (failed downloads): at most one per this long. */
  djNoticeCooldownMs: 2 * 60_000,
  /** An active session with no HuddleFM event for this long gets a status probe (a restarted HuddleFM drops grants). */
  djProbeAfterMs: 10 * 60_000,
  /** An active session HuddleFM hasn't answered for this long is ended (it was probed every few minutes). */
  djGiveUpAfterMs: 60 * 60_000,
} as const;
