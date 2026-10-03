# smasnug-ai

Workspace Slack agent: a fast front agent that replies, reacts and delegates longer work to background subagents
shown in native Slack plan cards. Design: [docs/design.md](docs/design.md). Repo guide: [CLAUDE.md](CLAUDE.md).

## Run locally

```bash
docker compose up -d          # Postgres :5433, Redis :6380
cp .env.example .env          # fill in OPENROUTER_KEY + Slack tokens (docs/slack-setup.md)
pnpm install
pnpm migrate
pnpm dev:ingress              # Socket Mode intake (never calls a model)
pnpm dev:worker               # all queues: turns, subagents, cards, maintenance
```

Scale horizontally by running more workers; ingress and workers share nothing but Postgres and Redis.

## Without Slack

`SLACK_FAKE=1` replaces every Slack call with a recorded fake, so the whole system runs against real models:

```bash
pnpm simulate                 # injects mentions, follow-ups, DMs; prints Slack calls, turns, events
npx tsx --env-file=.env scripts/roster.ts   # which tools each role gets
```

## Tests

```bash
pnpm test                                             # unit
LIVE=1 INTEGRATION=1 pnpm vitest run --no-file-parallelism   # + Postgres/Redis integration and live OpenRouter
```

Not built yet (by design): the code sandbox for subagents, and observability (tracing/evals).
