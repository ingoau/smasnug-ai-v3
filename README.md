# smasnug ai v3

a vibe coded slack agent focused on user experience and low latency, using delegation to subagents.

## Run locally

```bash
docker compose up -d          # Postgres :5433, Redis :6380
cp .env.example .env          # fill in HACKCLUB_AI_KEY / OPENROUTER_KEY + Slack tokens (docs/slack-setup.md)
pnpm install
pnpm migrate
pnpm dev:ingress              # Socket Mode intake (never calls a model)
pnpm dev:worker               # all queues: turns, subagents, cards, maintenance
```

Scale horizontally by running more workers; ingress and workers share nothing but Postgres and Redis.

Models (GPT-6 Luna) go through [Hack Club AI](https://ai.hackclub.com) when `HACKCLUB_AI_KEY` is set, with OpenRouter
(`OPENROUTER_KEY`) as the fallback; web search uses Hack Club's Exa proxy, then Exa directly (`EXA_API_KEY`).

## Container

Every push to `main` builds `ghcr.io/ingoau/smasnug-ai-v3` (`latest` and `sha-<commit>`, amd64 + arm64). One image
runs both processes; pass the same environment as `.env`:

```bash
docker run --env-file .env ghcr.io/ingoau/smasnug-ai-v3 node dist/db/migrate.js     # once per deploy
docker run --env-file .env ghcr.io/ingoau/smasnug-ai-v3 node dist/ingress/main.js   # one instance
docker run --env-file .env ghcr.io/ingoau/smasnug-ai-v3                             # worker (default), scale out
```

## Tests

```bash
pnpm test                                             # unit
LIVE=1 INTEGRATION=1 pnpm vitest run --no-file-parallelism   # + Postgres/Redis integration and live OpenRouter
```

Tests never use the dev database or Redis from `.env`: they run against `TEST_DATABASE_URL` / `TEST_REDIS_URL`
(default: the `smasnug_test` database and Redis db 9 on the same servers), with `SLACK_FAKE=1` forced. The test
database is created and migrated automatically (`src/testing/`).

Not built yet (by design): the code sandbox for subagents, and observability (tracing/evals).
