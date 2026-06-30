#!/usr/bin/env bash
# Run on the Oracle VM when getbutler.xyz/api times out or login verify hangs.
set -euo pipefail

echo "=== Butler API recovery ==="

# Open firewall (Oracle iptables often blocks 3001 after reboot)
if command -v iptables >/dev/null 2>&1; then
  if ! sudo iptables -C INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null || true
  fi
  if ! sudo iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
  fi
fi

ROOT="${BUTLER_ROOT:-$HOME/agent}"
if [[ ! -d "$ROOT" ]]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

echo "Stopping API and clearing orphan Node/Circle processes…"
if systemctl is-active --quiet butler-api 2>/dev/null; then
  sudo systemctl stop butler-api 2>/dev/null || true
fi
sleep 1
sudo pkill -9 -f "${ROOT}/apps/api/dist/server.mjs" 2>/dev/null || true
sudo pkill -9 -f "${ROOT}/scripts/circle.sh" 2>/dev/null || true
sudo pkill -9 -f "${ROOT}/.vendor/circle-cli" 2>/dev/null || true

# Hung Node still binds :3001 but never sends HTTP — kill before restart
if command -v fuser >/dev/null 2>&1; then
  sudo fuser -k 3001/tcp 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  pid=$(sudo lsof -t -i:3001 2>/dev/null || true)
  [[ -n "$pid" ]] && sudo kill -9 $pid 2>/dev/null || true
fi
sleep 1

echo "Clearing stale Circle login jobs (avoid blocking boot with hung OTP sends)…"
rm -f "$ROOT/.data/circle-login-jobs"/*.json 2>/dev/null || true

echo "Syncing repo to origin/main…"
if [[ -d .git ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "  Discarding local tracked changes (deploy VM should match git)…"
    git status --short
  fi
  git fetch origin main
  git reset --hard origin/main
  git clean -fd -e .env -e '.data/**' -e '.vendor/**' -e '.circle-cli-global/**' 2>/dev/null || true
else
  echo "WARN: $ROOT is not a git repo — skipping pull"
fi

echo "Installing / building API…"
npm run install:render

echo "Freeing memory after build (avoid OOM on restart)…"
sudo pkill -9 -f "${ROOT}/scripts/circle.sh" 2>/dev/null || true
sudo pkill -9 -f "${ROOT}/.vendor/circle-cli" 2>/dev/null || true
sync 2>/dev/null || true
sleep 3

UNIT_SRC="$ROOT/scripts/butler-api.service"
UNIT_DST="/etc/systemd/system/butler-api.service"
AGENT_HOME="$(cd "$ROOT" && pwd)"
AGENT_USER="$(whoami)"
if [[ -f "$UNIT_SRC" ]]; then
  echo "Installing systemd unit for $AGENT_HOME (user $AGENT_USER)…"
  sed "s|/home/ubuntu/agent|${AGENT_HOME}|g; s|User=ubuntu|User=${AGENT_USER}|g" "$UNIT_SRC" | sudo tee "$UNIT_DST" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable butler-api 2>/dev/null || true
fi

echo "Restarting butler-api…"
if systemctl list-unit-files butler-api.service 2>/dev/null | grep -q butler-api; then
  sudo systemctl restart butler-api
  sleep 8
else
  echo "No butler-api systemd unit — starting manually (Ctrl+C to stop)"
  export BUTLER_LITE_API=true
  export BUTLER_ROOT="$ROOT"
  nohup node apps/api/dist/server.mjs >> /tmp/butler-api.log 2>&1 &
  sleep 3
fi

PUBLIC_IP="${BUTLER_PUBLIC_IP:-129.151.164.101}"

fetch_local_health() {
  curl -sf --max-time 5 http://127.0.0.1:3001/api/health 2>/dev/null || true
}

api_listening() {
  local body="$1"
  [[ -n "$body" ]] && echo "$body" | grep -q '"chain"'
}

api_live() {
  local body="$1"
  [[ -n "$body" ]] && echo "$body" | grep -q '"ok":true'
}

api_usable() {
  local body="$1"
  api_live "$body" && return 0
  [[ -n "$body" ]] && echo "$body" | grep -q '"mode":"loading"' && echo "$body" | grep -q '"executeRoutes":1[0-9]'
}

echo "Waiting for API health (local — routes may take up to 90s on small VMs)…"
for i in $(seq 1 30); do
  body=$(fetch_local_health)
  if api_live "$body" || api_usable "$body"; then
    echo "OK — API live locally"
    echo "$body"
    echo ""
    if command -v iptables >/dev/null 2>&1; then
      if ! sudo iptables -C INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null; then
        sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null || true
        echo "Opened iptables for tcp/3001"
      fi
    fi
    loader=$(curl -sf --max-time 8 http://127.0.0.1:3001/api/marketplace/loader-status 2>/dev/null || echo "")
    if echo "$loader" | grep -q '"executeRoutes":15'; then
      echo "OK — 15 agent execute routes registered"
    else
      echo "WARN — loader-status: ${loader:-unavailable}"
    fi
    probe=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3001/api/marketplace/agents/research-agent/execute-probe || echo "000")
    if [[ "$probe" == "402" ]]; then
      echo "OK — boot execute-probe responds (HTTP 402)"
    fi
    echo ""
    echo "Verify from browser: https://getbutler.xyz/api/health"
    echo "(Public IP curl from inside the VM often fails — Oracle hairpin NAT — that is normal.)"
    if ! crontab -l 2>/dev/null | grep -q oracle-watchdog; then
      echo ""
      echo "Tip: install auto-restart every minute (run once):"
      echo "  (crontab -l 2>/dev/null; echo \"*/1 * * * * $ROOT/scripts/oracle-watchdog.sh >> /tmp/butler-watchdog.log 2>&1\") | crontab -"
    fi
    exit 0
  fi
  if api_listening "$body"; then
    echo "  … booting (mode=$(echo "$body" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')) attempt $i/30"
  elif systemctl is-active --quiet butler-api 2>/dev/null; then
    echo "  … waiting for port 3001 (attempt $i/30)"
  else
    echo "  … butler-api not active yet (attempt $i/30)"
  fi
  sleep 3
done

echo "FAIL — API did not become healthy locally."
echo "Run: bash scripts/oracle-diagnose.sh"
sudo journalctl -u butler-api -n 40 --no-pager 2>/dev/null || true
exit 1
