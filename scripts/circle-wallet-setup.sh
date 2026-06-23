#!/usr/bin/env bash
# Circle CLI wallet setup for Butler executor (Lepton checklist 04).
set -euo pipefail

API="${VITE_API_URL:-http://localhost:3001}"
CHAIN="${CIRCLE_CHAIN:-ARC}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if command -v circle >/dev/null 2>&1; then
  CIRCLE_BIN="circle"
elif [[ -f "$ROOT/.vendor/circle-cli/dist/index.js" ]]; then
  CIRCLE_BIN="$ROOT/scripts/circle.sh"
else
  echo "Install Circle CLI: npm run circle:install"
  exit 1
fi

circle() { bash "$CIRCLE_BIN" "$@"; }

echo "==> Circle CLI wallet status"
circle wallet status 2>/dev/null || circle wallet login --help

echo ""
echo "==> Agent wallets on $CHAIN"
circle wallet list --chain "$CHAIN" --type agent --output json 2>/dev/null || true

echo ""
echo "==> Gateway balance (nanopayments)"
ADDR="${CIRCLE_EXECUTOR_ADDRESS:-}"
if [[ -z "$ADDR" ]]; then
  echo "Set CIRCLE_EXECUTOR_ADDRESS in .env after: circle wallet list --chain $CHAIN --output json"
  exit 0
fi

circle gateway balance --address "$ADDR" --chain "$CHAIN" --all 2>/dev/null || true

echo ""
echo "Deposit USDC into Gateway for x402 payments:"
echo "  circle gateway deposit --amount 1.0 --address $ADDR --chain $CHAIN --method eco"
echo ""
echo "Pay a Butler merchant:"
echo "  circle services pay $API/merchants/research/summary --address $ADDR --chain $CHAIN"
