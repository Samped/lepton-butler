#!/usr/bin/env bash
# Start Butler API — rebuild bundle when possible, but NEVER refuse to start if build fails.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${BUTLER_START_LOG:-/tmp/butler-api-start.log}"

export BUTLER_LITE_API="${BUTLER_LITE_API:-true}"
export BUTLER_ROOT="${BUTLER_ROOT:-$ROOT}"

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

log "Butler API start (ROOT=$ROOT)"

DIST="$ROOT/apps/api/dist/server.mjs"
SRC="$ROOT/apps/api/src/server.ts"

needs_build=0
if [[ ! -f "$DIST" ]]; then
  needs_build=1
  log "dist/server.mjs missing — will build"
elif [[ -f "$SRC" && "$SRC" -nt "$DIST" ]]; then
  needs_build=1
  log "source newer than dist — will rebuild"
fi

if [[ "$needs_build" -eq 1 ]]; then
  if (cd "$ROOT" && npm run build:render -w @butler/api >> "$LOG" 2>&1); then
    log "build OK"
  else
    log "WARN build failed — continuing with existing dist if available (see $LOG)"
  fi
else
  log "dist/server.mjs up to date — skipping build"
fi

cd "$ROOT/apps/api"
if [[ -f dist/server.mjs ]]; then
  log "exec node dist/server.mjs"
  exec node dist/server.mjs
fi

log "WARN dist/server.mjs missing — falling back to tsx src/server.ts"
exec node "$ROOT/node_modules/tsx/dist/cli.mjs" src/server.ts
