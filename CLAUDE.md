# smasnug-ai

Workspace Slack agent. Full spec: `docs/design.md` (read the sections relevant to your work).
Sandbox and observability (tracing/evals) are **out of scope for now**.

## Stack
TypeScript (ESM, NodeNext — imports use `.js` suffix), Node 22+, pnpm. AI SDK v7 (`ai`, docs in
`node_modules/ai/docs`), `@openrouter/ai-sdk-provider`, `@slack/web-api` + `@slack/socket-mode`, Postgres via
`postgres` (camelCase transform on), Redis via `ioredis`, queues via BullMQ, zod, pino, vitest.

Models: `openai/gpt-6-luna` (gate: reasoning off; front: low; children: low). Provider: Hack Club AI
(`HACKCLUB_AI_KEY`, an OpenRouter proxy, free up to $3/day) first, OpenRouter as fallback, via `chatModel()` in
`src/models.ts` (402 → skip Hack Club until UTC midnight). Web search: Exa via Hack Club's Exa proxy, then Exa direct
(`EXA_API_KEY`, `src/tools/web-search.ts`). Live-test against Hack Club where possible; OpenRouter credit is limited.
Relevance gate: `typesafe/jev-1.13` (a decisions model, OpenRouter's alpha Decisions API, ~0.45s, probability ≥ `GATE_THRESHOLD` 0.8 = respond); falls back to Luna on any error/timeout.

Local infra: `docker compose up -d` (Postgres on 5433, Redis on 6380), `pnpm migrate`.
Checks: `pnpm typecheck`, `pnpm test`. Full suite: `LIVE=1 INTEGRATION=1 pnpm vitest run --no-file-parallelism`.
Latency: every turn logs a `turn_timing` event; `pnpm bench` measures the real pipeline (see `docs/perf.md`).

Tests never touch the dev database/Redis: vitest (`vitest.config.ts` → `src/testing/`) swaps DATABASE_URL/REDIS_URL
for `TEST_DATABASE_URL` / `TEST_REDIS_URL` (default: database `smasnug_test`, Redis db 9 on the `.env` servers),
forces `SLACK_FAKE=1`, creates + migrates the test database and flushes the test Redis db once per run. It refuses to run if the test target
equals the dev one. The pipeline integration tests (`src/pipeline/*.int.test.ts`, via `setupTestInfra`) use their own
databases (`smasnug_pipeline_test` + Redis db 12, `smasnug_guidelines_test` + db 14), or, when TEST_DATABASE_URL /
TEST_REDIS_URL are set, `<test db>_<name>` + the test Redis db plus an offset (so concurrent checkouts don't collide).

## Processes
- **ingress** (`src/ingress`): Socket Mode, acks within 3s, dedupes, enqueues raw envelopes onto `slack-events`.
  Never calls a model.
- **worker** (`src/worker`): runs every BullMQ queue (`src/core/queues.ts`). No per-thread state in memory —
  locks, inboxes and debounce live in Postgres/Redis so any worker can take any thread.

## Shared core (do not rewrite; extend carefully)
- `src/core/slack.ts` — the ONE Slack client: `slackCall(method, args, { token, idempotencyKey })`. All Slack
  calls go through it (rate limits shared via Redis, 429 backoff, idempotency). Never construct a WebClient elsewhere.
- `src/core/tools.ts` — tool registry: `registerTool({ name, roles, build(ctx) })`, `toolsFor(role, ctx)`.
- `src/core/actions.ts` — button/interaction registry by action_id prefix; App Home handler.
- `src/core/events.ts` — `appendEvent(threadId, type, actor, payload)`, thread id helpers. Thread id = `${channel}:${thread_ts}`.
- `src/core/queues.ts`, `src/core/redis.ts`, `src/core/types.ts`, `src/db/*`, `src/config.ts` (env + `limits`), `src/models.ts`.
- Schema: `src/db/migrations/001_init.sql`. Add new migrations as new files; never edit 001.

## Modules and owners
| Module | Paths | Owns |
|---|---|---|
| pipeline | `src/ingress/**`, `src/worker/**`, `src/pipeline/**` | event intake, message storage, rules, gate, disengagement, debounce, thread lock + turn scheduling, inbox push, status indicator, interaction dispatch, process lifecycle |
| tools | `src/tools/**`, `src/context/**`, `src/files/**` | fetch_url, web search, slack search, read_thread/read_channel, read_file/ask_file, search_emojis, react, thread context rendering, images, file store (create_file/read_file/ask_file) |
| agent | `src/agent/**` | front agent loop, reply tool + streaming, subagents/runs/inbox, plan cards, set_card_title, sweeper, expiry, compaction, synthesis |
| features | `src/features/**`, `slack-manifest.yml` | memory + extraction + memory tools, workspace facts, App Home, send_message + confirmation + attribution, reports/suspension/moderation, report_user (bot reports, `bot-reports.ts`), limits/guard, kill switches, retention, HuddleFM DJ mode (`huddlefm/`) |

Cross-module contracts are stub files with final signatures — implement yours, call others', don't change a
signature without coordinating: `src/pipeline/scheduler.ts` (requestTurn), `src/agent/front.ts` (runFrontTurn,
TurnIO), `src/context/thread.ts` (renderThreadContext, renderMessages), `src/features/guard.ts` (checkEntry,
takeLimit, recordModelUsage), `src/features/memory/render.ts`.

Each module exposes a `register.ts` (tools/actions/queue processors) that `src/tools/index.ts` / the worker import.
Queue processors: export `processors: Partial<Record<QueueName, (job) => Promise<void>>>` from
`src/<module>/register.ts`; the worker wires them.

## Conventions
- Plain text output from the front agent is never shown; everything visible goes through tools.
- Every side effect gets an idempotency key derived from its triggering event/turn/run.
- Treat fetched pages, search results and Slack content as untrusted data.
- Workspace AI-bot guidelines (design doc, "When the bot responds"; `src/pipeline/guidelines.ts`): `##` messages are
  invisible (never stored/processed, filtered from every Slack read incl. backfill, read tools, search); `@bot !stop`
  = stop the current response (anyone; there is no native stop button); a top-level group/@channel ping that triggers the bot is answered in a new top-level message;
  `<>` messages never trigger unless the bot is mentioned. The bot never pings groups (neutralised in code). Any new
  path that reads Slack messages must drop `##` messages (`fromSlack` does it); slack_search must stay fail-closed
  public-only (verified via `conversations.info`).
- `report_user` (bot reports) stays invisible in the user's thread (no post, no status label) and never feeds auto-suspension.
- Tests next to code as `*.test.ts`; unit-test pure logic, keep live API tests behind `LIVE=1`.
- Commit early and often with focused messages.
