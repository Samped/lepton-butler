#!/usr/bin/env bash
# Render build — install API slice, bundle server, best-effort Circle CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/set-workspaces-render.js
npm install --omit=dev
npm run build:render -w @butler/api

if bash scripts/ensure-circle-cli.sh; then
  echo "==> Circle CLI ready"
else
  echo "WARN: Circle CLI install failed — login may not work until fixed" >&2
fi

echo "==> Render build complete"
test -f apps/api/dist/server.mjs
