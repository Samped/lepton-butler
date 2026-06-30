#!/usr/bin/env bash
# Cron-friendly: restart butler-api only when :3001 is down (not during route loading).
# Install: (crontab -l 2>/dev/null; echo "*/1 * * * * $HOME/agent/scripts/oracle-watchdog.sh >> /tmp/butler-watchdog.log 2>&1") | crontab -
set -euo pipefail

ROOT="${BUTLER_ROOT:-$HOME/agent}"
BOOT_TS_FILE="/tmp/butler-api-boot.ts"
BOOT_GRACE_SEC="${BUTLER_WATCHDOG_BOOT_GRACE_SEC:-120}"

fetch_health() {
  curl -sf --max-time 4 http://127.0.0.1:3001/api/health 2>/dev/null || true
}

body="$(fetch_health)"
if [[ -n "$body" ]] && echo "$body" | grep -q '"chain"'; then
  exit 0
fi

if [[ -f "$BOOT_TS_FILE" ]]; then
  boot_ts="$(cat "$BOOT_TS_FILE" 2>/dev/null || echo 0)"
  now_ts="$(date +%s)"
  if [[ "$boot_ts" =~ ^[0-9]+$ ]] && (( now_ts - boot_ts < BOOT_GRACE_SEC )); then
    exit 0
  fi
fi

if systemctl is-active --quiet butler-api 2>/dev/null; then
  enter_us="$(systemctl show butler-api -p ActiveEnterTimestampMonotonic --value 2>/dev/null || true)"
  if [[ "$enter_us" =~ ^[0-9]+$ ]]; then
    now_us="$(awk '{printf "%.0f\n", $1*1000000}' /proc/uptime)"
    # ActiveEnterTimestampMonotonic is microseconds since boot; compare with current monotonic time.
    # systemctl value is μs since boot at service start; elapsed ≈ now_us - enter_us.
    if (( now_us - enter_us < BOOT_GRACE_SEC * 1000000 )); then
      exit 0
    fi
  fi
fi

echo "$(date -Is) API not responding on :3001 — recovering butler-api"

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

date +%s >"$BOOT_TS_FILE"

if systemctl list-unit-files butler-api.service 2>/dev/null | grep -q butler-api; then
  sudo systemctl start butler-api
else
  cd "$ROOT"
  export BUTLER_LITE_API=true
  export BUTLER_ROOT="$ROOT"
  nohup node apps/api/dist/server.mjs >> /tmp/butler-api.log 2>&1 &
fi

sleep 15
body="$(fetch_health)"
if [[ -n "$body" ]] && echo "$body" | grep -q '"chain"'; then
  echo "$(date -Is) OK — API responding after watchdog restart"
else
  echo "$(date -Is) FAIL — still down; run: bash $ROOT/scripts/oracle-recover.sh"
fi
