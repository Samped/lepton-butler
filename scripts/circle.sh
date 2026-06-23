#!/usr/bin/env bash
# Run vendored Circle CLI (Lepton checklist 04).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export CIRCLE_ACCEPT_TERMS="${CIRCLE_ACCEPT_TERMS:-1}"
export FORCE_COLOR="${FORCE_COLOR:-0}"

run_cli() {
  local js="$1"
  local nm="$2"
  shift 2
  export NODE_PATH="$nm${NODE_PATH:+:$NODE_PATH}"
  exec node "$js" "$@"
}

smoke() {
  local js="$1"
  local nm="$2"
  NODE_PATH="$nm" node "$js" --version >/dev/null 2>&1
}

CLI="$ROOT/.vendor/circle-cli/dist/index.js"
VENDOR_NM="$ROOT/.vendor/circle-cli/node_modules"
if [[ -f "$CLI" ]] && smoke "$CLI" "$VENDOR_NM"; then
  run_cli "$CLI" "$VENDOR_NM" "$@"
fi

GLOBAL_JS="$ROOT/.circle-cli-global/node_modules/@circle-fin/cli/dist/index.js"
GLOBAL_NM="$ROOT/.circle-cli-global/node_modules"
if [[ -f "$GLOBAL_JS" ]] && smoke "$GLOBAL_JS" "$GLOBAL_NM"; then
  run_cli "$GLOBAL_JS" "$GLOBAL_NM" "$@"
fi

echo "Circle CLI not installed or dependencies broken. Run: npm run circle:install" >&2
exit 1
