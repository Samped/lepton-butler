#!/usr/bin/env bash
# Start Butler API — always rebuild bundle (esbuild ~1s), never block start on build failure.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${BUTLER_START_LOG:-/tmp/butler-api-start.log}"

export BUTLER_LITE_API="${BUTLER_LITE_API:-true}"
export BUTLER_ROOT="${BUTLER_ROOT:-$ROOT}"

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

log "Butler API start (ROOT=$ROOT)"

if (cd "$ROOT" && npm run build:render -w @butler/api >> "$LOG" 2>&1); then
  log "build OK ($(cat "$ROOT/apps/api/dist/build-stamp.json" 2>/dev/null || echo 'no stamp'))"
else
  log "WARN build failed — continuing with existing dist if available (see $LOG)"
fi

cd "$ROOT/apps/api"
if [[ -f dist/server.mjs ]]; then
  log "exec node dist/server.mjs"
  exec node dist/server.mjs
fi

log "WARN dist/server.mjs missing — falling back to tsx src/server.ts"
exec node "$ROOT/node_modules/tsx/dist/cli.mjs" src/server.ts
