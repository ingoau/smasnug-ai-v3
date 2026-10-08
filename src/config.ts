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
  /** Respond when the gate model's probability is at least this (contextual: see gateThreshold in pipeline/rules.ts). */
  GATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  /**
   * Threshold for the bot's own conversation partner: two-party threads, or the person it just replied to (0.6 let a
   * partner thinking aloud through at p ≈ 0.62).
   */
  GATE_PARTNER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  /**
   * Threshold for the bot's latest conversation partner when someone else wrote since the bot's reply, within
   * limits.recentPartnerMs of it (base 0.8 dropped a partner's question after a bystander's remark at p ≈ 0.55).
   */
  GATE_RECENT_PARTNER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  /** Threshold once the thread is cooling (idle longer than limits.gateCoolingAfterMs). */
  GATE_COOLING_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  BOT_DISPLAY_NAME: z.string().default('smasnug ai'),
  LOG_LEVEL: z.string().default('info'),
  /**
   * Turn activity text (src/agent/activity-trail.ts): `tasks` = transient task cards in the reply message, `off` =
   * Slack's "Working…" only. The old values `overlay` / `text` (deprecated assistant.threads.setStatus) mean `tasks`.
   */
  STATUS_ACTIVITY_MODE: z.preprocess((v) => (v === 'overlay' || v === 'text' ? 'tasks' : v), z.enum(['tasks', 'off'])).default('tasks'),
  /**
   * Front agent reasoning effort on OpenRouter (see docs/perf.md for the latency/quality comparison). `low` relies on
   * required tool calls + the one-time plain-text nudge (front.ts) so it doesn't end turns with unshown text.
   */
  FRONT_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium']).default('low'),
  /**
   * Reasoning effort for subagent runs; `default` = the model's own default. `medium`: researched answers are right
   * more often than at `low` (which is faster); `high` gained nothing (docs/perf.md).
   */
  CHILD_REASONING_EFFORT: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high']).default('medium'),
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
  /**
   * Code sandboxes (src/sandbox/, docs/sandbox.md): subagents spawned with `sandbox: true` run code in Modal
   * Sandboxes. Off (no tools, no jobs, no App Home section) unless MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are set.
   * Never logged; never passed into a sandbox.
   */
  MODAL_TOKEN_ID: z.string().optional(),
  MODAL_TOKEN_SECRET: z.string().optional(),
  /** Modal environment (dev and prod share one workspace and its free credit, but use separate environments). */
  MODAL_ENVIRONMENT: z.string().optional(),
  /** Modal app the sandboxes are created under (per environment). */
  MODAL_APP_NAME: z.string().default('smasnug-sandbox'),
  /** Sandbox provider behind src/sandbox/provider.ts. Only Modal is implemented (E2B is the documented fallback). */
  SANDBOX_PROVIDER: z.enum(['modal']).default('modal'),
  /**
   * Hard stop for this deployment's estimated sandbox spend per calendar month (UTC), in USD. Below Modal's $30/month
   * free credit, which dev and prod share: give dev a small slice (e.g. 5) and prod the rest (e.g. 20).
   */
  SANDBOX_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(20),
  /**
   * Second backstop: Modal's own metered cost for the whole workspace this month (all environments). At or above
   * this, new sandboxes are refused everywhere (the credit is $30; the workspace spend limit is $0 beyond it).
   */
  SANDBOX_WORKSPACE_CREDIT_USD: z.coerce.number().min(0).default(28),
  /** Extra egress deny list (comma-separated IPv4 CIDRs or IPs), e.g. our own hosts' public addresses. */
  SANDBOX_EGRESS_DENY: z.string().optional(),
  /**
   * Live previews (Cloudflare temporary deploys, src/sandbox/preview/): AES-256-GCM key for the preview's Cloudflare
   * token and claim URL (32 bytes, base64). Previews are off without it.
   */
  PREVIEW_SECRET_KEY: z.string().optional(),
  /** Bump when Cloudflare's terms change: requesters accept again on their next preview. */
  PREVIEW_TERMS_VERSION: z.string().default('cf-2025-10'),
  /** wrangler version used by the preview deploy sandbox (pinned). */
  WRANGLER_VERSION: z.string().default('4.148.0'),
  /** Hack Club Auth (identity verification check for sandbox access). */
  HCA_URL: z.string().default('https://auth.hackclub.com'),
});

export const env = Env.parse(process.env);

/** Tunables from the design doc. Values marked TBD in the doc are best guesses. */
export const limits = {
  debounceIdleMs: 1000,
  /** DMs / mentions / two-party follow-ups (no gate): short window, see debounceWindowMs. */
  debounceDirectMs: 300,
  debounceBusyMs: 3000,
  /**
   * Turn hold (src/pipeline/turn-hold.ts): a results (synthesis) or scheduled turn waits up to turnHoldMaxMs while a
   * human message in the thread is still in its debounce window or at the relevance gate, re-checking every
   * turnHoldPollMs (delayed thread-run job; the debounce fire also wakes it). The gate's in-flight marker expires
   * after gateInflightTtlMs if a worker dies mid-gate.
   */
  turnHoldMaxMs: 8000,
  turnHoldPollMs: 1000,
  gateInflightTtlMs: 30_000,
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
  /**
   * <channel_background> only for threads with at most this many replies before the turn, or when the new message
   * points at something ("this", "^", "above", "thoughts?", a bare ping; src/context/channel-background.ts).
   */
  channelBackgroundMaxReplies: 3,
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
  // file store (src/files/)
  /** Largest file stored (created files, and uploads' content; bigger uploads: images are still viewable, others not). */
  fileMaxBytes: 5 * 1024 * 1024,
  /** read_file: text page size (chars). */
  fileReadPageChars: 24_000,
  /** ask_file: the file text given to the answering model at most (≈tokens; the head, with a note). */
  askFileMaxTokens: 60_000,
  askFileTimeoutMs: 90_000,
  /** ask_file calls per front turn / subagent run (batches: one call per screenshot, in parallel). */
  askFileMaxCallsPerTurn: 12,
  /** create_file calls per front turn / subagent run. */
  createFileMaxPerTurn: 20,
  /** Files the bot made are deleted this long after creation (uploads follow message retention). */
  createdFileRetentionMs: 30 * 24 * 60 * 60 * 1000,
  disengageAfterMessages: 25,
  /** Full disengagement after this long without being addressed and without a bot reply. */
  disengageAfterMs: 7 * 24 * 60 * 60 * 1000,
  /** Idle (no address, no bot reply) longer than this: the thread is cooling and the gate uses GATE_COOLING_THRESHOLD. */
  gateCoolingAfterMs: 3 * 60 * 60 * 1000,
  /**
   * The bot's latest conversation partner, after someone else wrote, stays a "recent partner" (gate at
   * GATE_RECENT_PARTNER_THRESHOLD) for this long after the bot's reply to them.
   */
  recentPartnerMs: 10 * 60 * 1000,
  /** A previous turn's tool calls are shown to the next user turn when it finished at most this long ago. */
  previousTurnToolsMaxAgeMs: 30 * 60 * 1000,
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
  // slack_search on the shared user token (search.messages: ~25 per 30 s (≈50/min) measured on the dev app 2026-10-07;
  // Tier 2, undocumented beyond 20+/min. Our limiter: 20 per 30-s window, src/core/slack.ts; src/tools/slack-search.ts)
  /**
   * An interactive search (front-agent turn: a user is waiting) that would wait longer than this for the shared rate
   * limiter returns a "rate limited" result instead.
   */
  slackSearchMaxWaitMs: 6_000,
  /**
   * Background searches (subagents, watches) wait up to this long: one search.messages window (30 s) plus a margin,
   * so a burst that empties the background share is served as the window refills instead of failing.
   */
  slackSearchBackgroundMaxWaitMs: 32_000,
  /**
   * Interactive Slack reads inside tools (conversations.info visibility checks, read_public_thread / ask_thread /
   * read_public_channel history, users.info for names) give up after waiting this long for the shared rate limiter:
   * fail closed / skip with a "rate limited" note instead of a long silent stall.
   */
  slackToolMaxWaitMs: 15_000,
  /** The same reads in background work (subagents, watches): wait up to about one search window too. */
  slackToolBackgroundMaxWaitMs: 32_000,
  /** search.messages slots per 30-s window only interactive calls (front-agent turns) may use; background (subagents, watches) get the rest. */
  slackSearchInteractiveReserve: 4,
  /** Identical searches (query, sort, page) share their public results for this long (Redis; public matches only). */
  slackSearchCacheTtlS: 90,
  /** After this many slack_search calls in one subagent run, results carry a note to read threads instead. Not a block. */
  slackSearchSoftBudgetPerRun: 12,
  // per thread / run
  threadConcurrentSubagents: 10,
  runMaxDurationMs: 10 * 60 * 1000,
  /**
   * Cumulative tokens of a run's model steps (every step re-sends the whole history, mostly served from the prompt
   * cache). 400k ended Slack-heavy research after ~10 steps (context grows ~5-10k per step of search results); deep
   * research runs 15-25 steps. Then the run is told to report what it has.
   */
  runMaxTokens: 1_000_000,
  /**
   * Front-turn lookup guard (src/agent/lookup-guard.ts): after this many lookup-only steps in one front turn, a note
   * tells the agent to delegate with spawn_subagent (or answer). 0 turns the guard off.
   */
  frontLookupNudgeSteps: 3,
  /** ...and after this many more lookup-only steps, the research tools are switched off for the rest of the turn. */
  frontLookupRestrictSteps: 2,
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
  /** A slack_search watch check that found the search rate limiter busy is retried after this (capped at its interval). */
  watchBusyRetryMs: 10 * 60_000,
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
  // code sandboxes (src/sandbox/, docs/sandbox.md §4.2)
  /** CPU cores: reserved (billed at least this) and hard limit. Spend is estimated at the limit (an upper bound). */
  sandboxCpu: 0.5,
  sandboxCpuLimit: 1,
  /** Memory MiB: reserved and hard limit (Chromium needs ~1-2 GiB). */
  sandboxMemoryMiB: 1024,
  sandboxMemoryLimitMiB: 2048,
  /**
   * Provider-side lifetime of one live segment (Modal `timeout`). Must exceed sandboxRunMaxDurationMs plus
   * sandboxIdlePauseMs plus a sweep, so an idle sandbox is paused (snapshotted) before the provider kills it.
   */
  sandboxLifetimeMs: 45 * 60_000,
  /** A live sandbox whose subagent has no active run is paused (filesystem snapshot + terminate) after this. */
  sandboxIdlePauseMs: 5 * 60_000,
  /**
   * When a sandbox subagent's run ends (complete / failed / cancelled) and no other run of it is queued, its sandbox
   * is paused this long after (a delayed pause job) instead of after sandboxIdlePauseMs: idle live time counts
   * against the user's daily sandbox minutes and the budget. A follow-up within the grace reuses the live sandbox.
   */
  sandboxRunEndPauseMs: 45_000,
  /** Run duration cap for subagents with a sandbox (other runs keep runMaxDurationMs). */
  sandboxRunMaxDurationMs: 30 * 60_000,
  sandboxExecDefaultMs: 60_000,
  sandboxExecMaxMs: 300_000,
  /** stdout / stderr kept per exec (each), before the head/tail cut shown to the model. */
  sandboxExecOutputMaxBytes: 64 * 1024,
  sandboxExecShowHeadChars: 2_000,
  sandboxExecShowTailChars: 10_000,
  /** sandbox_write_file content cap (bigger files: make them with sandbox_exec). */
  sandboxWriteMaxBytes: 200 * 1024,
  sandboxReadPageChars: 24_000,
  /** Largest file sandbox_read_file pulls out of the sandbox to show (images are resized afterwards). */
  sandboxReadMaxBytes: 25 * 1024 * 1024,
  sandboxImportMaxBytes: 50 * 1024 * 1024,
  /** Sandbox exports into the file store (the store's general cap, fileMaxBytes, stays 5 MB for everything else). */
  sandboxExportMaxBytes: 25 * 1024 * 1024,
  userSandboxExecsPerHour: 200,
  userLiveSandboxes: 2,
  globalLiveSandboxes: 8,
  /** Live sandbox minutes per user per UTC day (sum of usage segments). */
  userSandboxMinutesPerDay: 30,
  userPreviewsPerDay: 5,
  globalPreviewsPerDay: 30,
  previewMaxFiles: 1000,
  previewMaxFileBytes: 5 * 1024 * 1024,
  previewMaxTotalBytes: 25 * 1024 * 1024,
  /** Cloudflare deletes unclaimed temporary deployments after 60 min; redeploys don't extend it. */
  previewLifetimeMs: 60 * 60_000,
  previewTermsTtlMs: 30 * 60_000,
  previewDeployTimeoutMs: 4 * 60_000,
  /** HCA: a positive answer is trusted this long before re-checking (and kept as the "last known positive"). */
  hcaPositiveTtlMs: 7 * 24 * 60 * 60 * 1000,
  hcaNegativeTtlMs: 10 * 60_000,
  hcaPendingTtlMs: 5 * 60_000,
  hcaTimeoutMs: 3_000,
  /** At most one access explanation (ephemeral) per user per this long. */
  sandboxNoticeCooldownMs: 15 * 60_000,
  /** sandboxes / previews rows are kept this long after they end; usage segments longer (they cover a billing month). */
  sandboxRowRetentionMs: 30 * 24 * 60 * 60 * 1000,
  sandboxUsageRetentionMs: 62 * 24 * 60 * 60 * 1000,
  /** hca_verifications rows not re-checked for this long are dropped. */
  hcaRowRetentionMs: 30 * 24 * 60 * 60 * 1000,
  // Workspace directory (src/tools/directory/): people + public channels, the one profile store.
  /** find_people + find_channels calls per user per hour (generous: they're cheap Postgres queries). */
  userDirectoryLookupsPerHour: 300,
  /** A profile not refreshed (crawl, users.info, event) for this long is re-read with users.info on lookup. */
  directoryProfileMaxAgeMs: 24 * 60 * 60 * 1000,
  /** A crawl kind whose last complete crawl is older than this is crawled again (the weekly re-crawl). */
  directoryRecrawlAfterMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * The public-channel check (slack_search & co., `channelVisibility`) trusts a directory_channels row confirmed within
   * this long (the weekly re-crawl plus a day of slack); older or missing rows are re-verified with conversations.info.
   */
  directoryChannelTrustMaxAgeMs: 8 * 24 * 60 * 60 * 1000,
  /** Pause between crawl pages: users.list / conversations.list are Tier 2 (20+/min); ≈17 pages/min. */
  directoryCrawlPageIntervalMs: 3_500,
  /** users.list page size (Slack recommends ≤ 200, allows 1000; may return fewer). */
  directoryUsersPageSize: 500,
  /** conversations.list page size (max 1000; Slack may return fewer after filtering). */
  directoryChannelsPageSize: 1000,
  /**
   * Progress estimates for the "directory still building (N%)" note, only until a kind's first complete crawl (then
   * its last row count is used). Hack Club: ~240k people rows (users + bots).
   */
  directoryPeopleEstimate: 240_000,
  directoryChannelsEstimate: 25_000,
} as const;

/**
 * Modal's sandbox rates (USD per core-hour / GiB-hour), read from the workspace's billing rates in the Phase 0 spike
 * (2026-10-07: `cpu_hour_cost_sandbox` 0.1419, `mem_gib_hour_cost_sandbox` 0.024). Billed at max(reservation, usage).
 */
export const sandboxPricing = {
  cpuCoreHourUsd: 0.1419,
  memGibHourUsd: 0.024,
} as const;
