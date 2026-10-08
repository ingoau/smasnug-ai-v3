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
