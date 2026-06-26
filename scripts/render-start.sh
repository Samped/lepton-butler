#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/api"

export BUTLER_LITE_API="${BUTLER_LITE_API:-true}"
export BUTLER_ROOT="${BUTLER_ROOT:-$ROOT}"

if [[ -f dist/server.mjs ]]; then
  exec node dist/server.mjs
fi

echo "WARN: dist/server.mjs missing — falling back to tsx" >&2
exec node "$ROOT/node_modules/tsx/dist/cli.mjs" src/server.ts
