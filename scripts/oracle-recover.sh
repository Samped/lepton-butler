#!/usr/bin/env bash
# Run on the Oracle VM when getbutler.xyz/api times out or login verify hangs.
set -euo pipefail

echo "=== Butler API recovery ==="

# Open firewall (Oracle iptables often blocks 3001 after reboot)
if command -v iptables >/dev/null 2>&1; then
  sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null || true
  sudo iptables -I INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
fi

ROOT="${BUTLER_ROOT:-$HOME/agent}"
if [[ ! -d "$ROOT" ]]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

# Hung Node still binds :3001 but never sends HTTP — kill before restart
if command -v fuser >/dev/null 2>&1; then
  sudo fuser -k 3001/tcp 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  pid=$(sudo lsof -t -i:3001 2>/dev/null || true)
  [[ -n "$pid" ]] && sudo kill -9 $pid 2>/dev/null || true
fi
sleep 1

echo "Syncing repo to origin/main…"
if [[ -d .git ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "  Discarding local tracked changes (deploy VM should match git)…"
    git status --short
  fi
  git fetch origin main
  git reset --hard origin/main
  git clean -fd -e .env -e '.data/**' 2>/dev/null || true
else
  echo "WARN: $ROOT is not a git repo — skipping pull"
fi

echo "Installing / building API…"
npm run install:render

UNIT_SRC="$ROOT/scripts/butler-api.service"
UNIT_DST="/etc/systemd/system/butler-api.service"
if [[ -f "$UNIT_SRC" ]] && [[ ! -f "$UNIT_DST" || "$UNIT_SRC" -nt "$UNIT_DST" ]]; then
  echo "Installing systemd unit…"
  sudo cp "$UNIT_SRC" "$UNIT_DST"
  sudo systemctl daemon-reload
  sudo systemctl enable butler-api 2>/dev/null || true
fi

echo "Restarting butler-api…"
if systemctl list-unit-files butler-api.service 2>/dev/null | grep -q butler-api; then
  sudo systemctl restart butler-api
else
  echo "No butler-api systemd unit — starting manually (Ctrl+C to stop)"
  export BUTLER_LITE_API=true
  export BUTLER_ROOT="$ROOT"
  node apps/api/dist/server.mjs &
  sleep 2
fi

echo "Waiting for health…"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -sf --max-time 3 http://127.0.0.1:3001/api/health | grep -q '"ok":true'; then
    echo "OK — API is responding locally"
    curl -s http://127.0.0.1:3001/api/health
    echo ""
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3001/marketplace/agents/research-agent/execute || echo "000")
    if [[ "$code" == "402" ]]; then
      echo "OK — x402 agent execute routes live (HTTP 402)"
    else
      echo "WARN — research-agent execute returned HTTP $code (expected 402). Pull latest and rebuild."
    fi
    echo ""
    echo "Public check: https://getbutler.xyz/api/health"
    exit 0
  fi
  sleep 2
done

echo "FAIL — API still not responding. Check logs:"
echo "  sudo journalctl -u butler-api -n 80 --no-pager"
exit 1
