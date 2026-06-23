#!/usr/bin/env bash
# Export Arc RPC from arc-canteen ($RPC) for Butler dev servers.
set -euo pipefail

if [[ -f "$HOME/.arc-canteen/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.arc-canteen/env"
fi

if command -v arc-canteen >/dev/null 2>&1; then
  URL="$(arc-canteen rpc-url 2>/dev/null || true)"
  if [[ -n "$URL" && "$URL" == http* ]]; then
    export RPC="$URL"
    export ARC_TESTNET_RPC="$URL"
    echo "$URL"
    exit 0
  fi
fi

if [[ -n "${RPC:-}" ]]; then
  export ARC_TESTNET_RPC="$RPC"
  echo "$RPC"
  exit 0
fi

FALLBACK="${ARC_TESTNET_RPC:-https://rpc.testnet.arc.network}"
export ARC_TESTNET_RPC="$FALLBACK"
echo "$FALLBACK"
