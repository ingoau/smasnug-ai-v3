# smasnug ai v3

A workspace Slack agent for [Hack Club](https://hackclub.com): a fast front agent that replies in threads and DMs, stays quiet when it has nothing useful to add, and delegates longer work to background subagents.

Built for UX and low latency — native plan cards, streaming replies, Socket Mode (no public webhook URL), and horizontal scale via separate ingress and worker processes.

**Spec:** [`docs/design.md`](docs/design.md) · **Slack app setup:** [`docs/slack-setup.md`](docs/slack-setup.md) · **Latency notes:** [`docs/perf.md`](docs/perf.md) · **Contributor map:** [`CLAUDE.md`](CLAUDE.md)

## What it does

- Answers mentions and DMs; unmentioned follow-ups go through a cheap relevance gate so the bot stays out of the way
- Spawns background subagents for longer research (Slack search, web search, URL fetch, images) with live plan cards
- Remembers per-user preferences and maintains an admin-approved workspace knowledge base
- Can send messages on a user's behalf (with confirmation), manage reminders/watches, and work with Slack canvases
- Abuse controls: rate limits, reports, auto-suspension, kill switches
- Optional: the admin can launch Cursor coding agents against this repo to open PRs (see `.env.example`)

Not built yet (by design): a code sandbox for subagents, and observability (tracing/evals).

## Architecture (short)

| Process | Role |
|---|---|
| **ingress** (`src/ingress`) | Slack Socket Mode: ack within 3s, dedupe, enqueue onto `slack-events`. Never calls a model. |
| **worker** (`src/worker`) | All BullMQ queues (turns, subagents, cards, maintenance). No in-memory per-thread state — locks, inboxes, and debounce live in Postgres/Redis so any worker can take any thread. |

Scale by running more workers. Ingress and workers share only Postgres and Redis.

Models ([GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna)) go through [Hack Club AI](https://ai.hackclub.com) when `HACKCLUB_AI_KEY` is set, with OpenRouter (`OPENROUTER_KEY`) as the fallback. Web search uses Hack Club's Exa proxy, then Exa directly (`EXA_API_KEY`).

## Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io) 10 (`packageManager` in `package.json`)
- Docker (Postgres + Redis via Compose)

## Run locally

1. Create a Slack app from [`slack-manifest.yml`](slack-manifest.yml) and copy tokens — step-by-step in [`docs/slack-setup.md`](docs/slack-setup.md). Use a separate app in a test workspace for development.
2. Start infra and configure env:

```bash
docker compose up -d          # Postgres :5433, Redis :6380
cp .env.example .env          # HACKCLUB_AI_KEY and/or OPENROUTER_KEY, Slack tokens, ADMIN_USER_ID, MOD_CHANNEL_ID
pnpm install
pnpm migrate
```

3. Run both processes (two terminals):

```bash
pnpm dev:ingress              # Socket Mode intake
pnpm dev:worker               # queues: turns, subagents, cards, maintenance
```

Invite the bot to channels where it should participate. Useful extras: `pnpm typecheck`, `pnpm bench` (pipeline latency; see [`docs/perf.md`](docs/perf.md)), `pnpm simulate` (fake Slack).

## Container

Every push to `main` builds [`ghcr.io/ingoau/smasnug-ai-v3`](https://github.com/ingoau/smasnug-ai-v3/pkgs/container/smasnug-ai-v3) (`latest` and `sha-<commit>`, amd64 + arm64). One image runs both processes; pass the same environment as `.env`:

```bash
docker run --env-file .env ghcr.io/ingoau/smasnug-ai-v3 node dist/db/migrate.js     # once per deploy
docker run --env-file .env ghcr.io/ingoau/smasnug-ai-v3 node dist/ingress/main.js   # one instance
docker run --env-file .env ghcr.io/ingoau/smasnug-ai-v3                             # worker (default), scale out
```

## Tests

```bash
pnpm test                                                             # unit + integration (fake Slack)
LIVE=1 INTEGRATION=1 pnpm vitest run --no-file-parallelism            # + live model/API calls
```

Tests never use the dev database or Redis from `.env`: they run against `TEST_DATABASE_URL` / `TEST_REDIS_URL` (default: database `smasnug_test`, Redis db 9 on the same servers), with `SLACK_FAKE=1` forced. The test database is created and migrated automatically (`src/testing/`). Vitest refuses to run if the test target equals the dev one.

## License

[AGPL-3.0-only](LICENSE)
