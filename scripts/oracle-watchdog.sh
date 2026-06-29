#!/usr/bin/env bash
# Cron-friendly: restart butler-api when localhost health stops responding.
# Install: (crontab -l 2>/dev/null; echo "*/1 * * * * $HOME/agent/scripts/oracle-watchdog.sh >> /tmp/butler-watchdog.log 2>&1") | crontab -
set -euo pipefail

ROOT="${BUTLER_ROOT:-$HOME/agent}"

if curl -sf --max-time 4 http://127.0.0.1:3001/api/health | grep -q '"ok":true'; then
  exit 0
fi

echo "$(date -Is) localhost health failed — recovering butler-api"

if command -v iptables >/dev/null 2>&1; then
  if ! sudo iptables -C INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null || true
  fi
fi

rm -f "$ROOT/.data/circle-login-jobs"/*.json 2>/dev/null || true

if systemctl is-active --quiet butler-api 2>/dev/null; then
  sudo systemctl stop butler-api 2>/dev/null || true
fi
sudo pkill -9 -f "${ROOT}/apps/api/dist/server.mjs" 2>/dev/null || true
sudo pkill -9 -f "${ROOT}/scripts/circle.sh" 2>/dev/null || true
if command -v fuser >/dev/null 2>&1; then
  sudo fuser -k 3001/tcp 2>/dev/null || true
fi
sleep 2

if systemctl list-unit-files butler-api.service 2>/dev/null | grep -q butler-api; then
  sudo systemctl start butler-api
else
  cd "$ROOT"
  export BUTLER_LITE_API=true
  export BUTLER_ROOT="$ROOT"
  nohup node apps/api/dist/server.mjs >> /tmp/butler-api.log 2>&1 &
fi

sleep 5
if curl -sf --max-time 5 http://127.0.0.1:3001/api/health | grep -q '"ok":true'; then
  echo "$(date -Is) OK — API responding after watchdog restart"
else
  echo "$(date -Is) FAIL — still down; run: bash $ROOT/scripts/oracle-recover.sh"
fi
