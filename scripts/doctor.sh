#!/usr/bin/env bash
# Environment diagnostics (read-only).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node node_modules/tsx/dist/cli.mjs tools/local/src/doctor.ts
