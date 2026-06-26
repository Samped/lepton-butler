#!/usr/bin/env bash
# Install Circle CLI for API login/payments. Used on Render and local setup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

vendor_cli="$ROOT/.vendor/circle-cli/dist/index.js"
global_cli="$ROOT/.circle-cli-global/node_modules/@circle-fin/cli/dist/index.js"

if [[ -f "$vendor_cli" ]] || [[ -f "$global_cli" ]]; then
  echo "==> Circle CLI already present"
  bash "$ROOT/scripts/circle.sh" --version
  exit 0
fi

echo "==> Installing Circle CLI (vendor bundle)"
if python3 "$ROOT/scripts/install-circle-cli.py"; then
  bash "$ROOT/scripts/circle.sh" --version
  exit 0
fi

echo "==> Vendor install failed; trying npm fallback to .circle-cli-global"
mkdir -p "$ROOT/.circle-cli-global"
npm install @circle-fin/cli@0.0.5 --prefix "$ROOT/.circle-cli-global" --omit=dev --no-audit --no-fund

if bash "$ROOT/scripts/circle.sh" --version; then
  echo "==> Circle CLI ready (npm fallback)"
  exit 0
fi

echo "FAIL: Circle CLI could not be installed" >&2
exit 1
