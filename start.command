#!/usr/bin/env bash
# Social Spy Automation - start (macOS; also works on Linux). Native mode by default (no Docker needed).
#   ./start.command            native: embedded PostgreSQL + Redis if installed (brew install redis)
#   ./start.command --docker   Docker Compose
# First time on macOS: chmod +x start.command stop.command
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[start] Node.js 22 LTS is required: https://nodejs.org (or: brew install node@22)"
  read -r -p "Press Enter to close" _ || true
  exit 1
fi

if [ "${1:-}" = "--docker" ]; then
  command -v docker >/dev/null 2>&1 || { echo "[start] Docker is not installed. Run without --docker for native mode."; exit 1; }
  [ -f .env ] || cp .env.example .env
  docker compose up -d --build
  APP_PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2 || true)"
  APP_PORT="${APP_PORT:-18966}"
  echo "[start] Running at http://127.0.0.1:${APP_PORT}"
  open "http://127.0.0.1:${APP_PORT}" 2>/dev/null || true
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "[start] Installing dependencies (first run)..."
  npm ci
fi

exec node node_modules/tsx/dist/cli.mjs tools/local/src/start.ts
