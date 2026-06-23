#!/usr/bin/env bash
# Deploy MetaMask Delegation Framework v1.3.0 to Arc testnet (deterministic CREATE2 addresses).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/packages/contracts/lib/delegation-framework"

if [[ ! -d "$LIB" ]]; then
  echo "==> Cloning MetaMask delegation-framework..."
  mkdir -p "$ROOT/packages/contracts/lib"
  git clone --depth 1 --branch v1.3.0 https://github.com/MetaMask/delegation-framework.git "$LIB"
fi

: "${BUTLER_DEPLOYER_PRIVATE_KEY:?Set BUTLER_DEPLOYER_PRIVATE_KEY}"
: "${ARC_TESTNET_RPC:=https://rpc.testnet.arc.network}"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

bash "$ROOT/scripts/bootstrap-foundry.sh"

cd "$LIB"
source .env.example 2>/dev/null || true

echo "==> Deploy Delegation Framework to Arc"
forge script script/DeployDelegationFramework.s.sol \
  --rpc-url "$ARC_TESTNET_RPC" \
  --private-key "$BUTLER_DEPLOYER_PRIVATE_KEY" \
  --broadcast

echo "==> Deploy caveat enforcers"
forge script script/DeployCaveatEnforcers.s.sol \
  --rpc-url "$ARC_TESTNET_RPC" \
  --private-key "$BUTLER_DEPLOYER_PRIVATE_KEY" \
  --broadcast

echo "==> Deploy ButlerSpendEnforcer"
cd "$ROOT/packages/contracts"
forge script script/DeployButlerEnforcer.s.sol \
  --rpc-url "$ARC_TESTNET_RPC" \
  --private-key "$BUTLER_DEPLOYER_PRIVATE_KEY" \
  --broadcast

echo "==> Done. Set BUTLER_SPEND_ENFORCER_ADDRESS in .env"
