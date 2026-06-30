#!/usr/bin/env bash
# Install Circle CLI for API login/payments. Used on Render and local setup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

vendor_cli="$ROOT/.vendor/circle-cli/dist/index.js"
global_cli="$ROOT/.circle-cli-global/node_modules/@circle-fin/cli/dist/index.js"

cli_files_present() {
  [[ -f "$vendor_cli" || -f "$global_cli" ]]
}

# Never boot Circle CLI during deploy builds — OOM on small VMs (installer verifies once).
if [[ "${BUTLER_SKIP_CLI_SMOKE:-}" == "1" ]] || cli_files_present; then
  if cli_files_present; then
    echo "==> Circle CLI already present"
    exit 0
  fi
fi

echo "==> Installing Circle CLI (vendor bundle)"
if python3 "$ROOT/scripts/install-circle-cli.py"; then
  echo "==> Circle CLI install complete (verified by installer)"
  exit 0
fi

echo "==> Vendor install failed; trying npm fallback to .circle-cli-global"
mkdir -p "$ROOT/.circle-cli-global"
npm install @circle-fin/cli@0.0.5 --prefix "$ROOT/.circle-cli-global" --omit=dev --no-audit --no-fund

if cli_files_present; then
  echo "==> Circle CLI ready (npm fallback)"
  exit 0
fi

echo "FAIL: Circle CLI could not be installed" >&2
exit 1
