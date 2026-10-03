#!/usr/bin/env bash
# Restart the live bot from a clean checkout of the latest commit (never from uncommitted work in progress).
# Runs ingress + worker from .claude/worktrees/run, logs to .logs/. Usage: scripts/restart-bot.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.claude/worktrees/run"
cd "$ROOT"
mkdir -p .logs
[ -d "$RUN" ] || git worktree add --detach "$RUN" HEAD -q
git -C "$RUN" checkout --detach -q "$(git rev-parse HEAD)"
cp .env "$RUN/.env"
(cd "$RUN" && pnpm install --frozen-lockfile --silent && pnpm migrate >/dev/null)
pkill -f "tsx/dist/cli.mjs.*--env-file=.env src/(worker|ingress)/main.ts" || true
for _ in $(seq 1 25); do pgrep -f "src/(worker|ingress)/main.ts" >/dev/null || break; sleep 1; done
cd "$RUN"
nohup npx tsx --env-file=.env src/worker/main.ts >> "$ROOT/.logs/worker.log" 2>&1 &
nohup npx tsx --env-file=.env src/ingress/main.ts >> "$ROOT/.logs/ingress.log" 2>&1 &
echo "bot restarted at $(git rev-parse --short HEAD)"
