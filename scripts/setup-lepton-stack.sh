#!/usr/bin/env bash
# Lepton RFB checklist — install ARC CLI, Circle CLI, circle-agent reference, arc context.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Lepton Butler — Lepton stack setup"
echo ""

# --- 03 ARC CLI (arc-canteen) ---
if command -v arc-canteen >/dev/null 2>&1; then
  echo "✓ arc-canteen already installed: $(arc-canteen --help 2>&1 | head -1 || true)"
else
  if command -v uv >/dev/null 2>&1; then
    echo "==> Installing ARC CLI via uv..."
    uv tool install "git+https://github.com/the-canteen-dev/ARC-cli.git"
    echo "  Run: arc-canteen login"
    echo "  Then: arc-canteen shell-init >> ~/.bashrc"
  else
    echo "⚠ uv not found. Install uv (https://docs.astral.sh/uv/) then run:"
    echo "  uv tool install git+https://github.com/the-canteen-dev/ARC-cli.git"
  fi
fi

# --- 04 Circle CLI ---
if command -v circle >/dev/null 2>&1; then
  echo "✓ circle CLI: $(circle --version 2>/dev/null || echo ok)"
else
  echo "==> Installing Circle CLI..."
  if npm install -g @circle-fin/cli@latest 2>/dev/null; then
    echo "✓ circle installed globally"
  else
    echo "⚠ npm global install failed. Run manually:"
    echo "  npm install -g @circle-fin/cli"
    echo "  circle wallet login <email> --testnet"
  fi
fi

# --- 05 circle-agent companion ---
VENDOR_AGENT="$ROOT/vendor/circle-agent"
if [[ -d "$VENDOR_AGENT/.git" ]]; then
  echo "✓ vendor/circle-agent present"
  git -C "$VENDOR_AGENT" pull --ff-only 2>/dev/null || true
else
  echo "==> Cloning circle-agent (Arc 101 companion)..."
  mkdir -p "$ROOT/vendor"
  rm -rf "$VENDOR_AGENT"
  git clone --depth 1 https://github.com/the-canteen-dev/circle-agent.git "$VENDOR_AGENT"
fi
echo "  Arc 101 trace APIs: /api/settlement, /api/batch-tx, /api/decode-batch"

# --- Foundry libs for delegation deploy ---
if command -v forge >/dev/null 2>&1; then
  bash "$ROOT/scripts/bootstrap-foundry.sh" || true
else
  echo "⚠ Foundry not installed — run npm run delegation:bootstrap after foundryup"
fi

# --- arc-canteen agent context ---
if command -v arc-canteen >/dev/null 2>&1; then
  if arc-canteen context sync 2>/dev/null; then
    echo "✓ arc-canteen context synced"
  else
    echo "  Run arc-canteen login then: npm run arc:context"
  fi
fi

# --- Load RPC into .env if arc-canteen logged in ---
if command -v arc-canteen >/dev/null 2>&1; then
  RPC_URL="$(arc-canteen rpc-url 2>/dev/null || true)"
  if [[ -n "$RPC_URL" && "$RPC_URL" == http* ]]; then
    if [[ -f .env ]]; then
      if grep -q '^ARC_TESTNET_RPC=' .env; then
        sed -i "s|^ARC_TESTNET_RPC=.*|ARC_TESTNET_RPC=$RPC_URL|" .env
      else
        echo "ARC_TESTNET_RPC=$RPC_URL" >> .env
      fi
      echo "✓ ARC_TESTNET_RPC set from arc-canteen in .env"
    else
      echo "  arc-canteen RPC available — copy .env.example → .env to persist"
    fi
  fi
fi

echo ""
echo "==> Next steps"
echo "  1. arc-canteen login          # Canteen GitHub auth + RPC token"
echo "  2. circle wallet login <email> --testnet"
echo "  3. cp .env.example .env && fund wallets at faucet.circle.com"
echo "  4. npm run install:deps && npm run dev"
echo "  5. Open http://localhost:5174 → Circle payer login → Agent tab"
echo ""
echo "Docs: docs/LEPTON_CHECKLIST.md"
