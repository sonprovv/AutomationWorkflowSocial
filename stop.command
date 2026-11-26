#!/usr/bin/env bash
# Social Spy Automation - stop (macOS/Linux). Stops only this project's processes/containers. Data is kept.
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "--docker" ]; then
  exec docker compose stop
fi
exec node node_modules/tsx/dist/cli.mjs tools/local/src/stop.ts
