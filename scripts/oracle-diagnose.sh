#!/usr/bin/env bash
# Run on the Oracle VM when getbutler.xyz/api 502 but localhost health works.
set -euo pipefail

ROOT="${BUTLER_ROOT:-$HOME/agent}"
PUBLIC_IP="${BUTLER_PUBLIC_IP:-129.151.164.101}"

echo "=== Butler API diagnose ==="
echo "Public IP: $PUBLIC_IP"
echo ""

echo "1. Process listening on :3001"
sudo ss -tlnp | grep ':3001' || echo "  (nothing on 3001)"
echo ""

echo "2. Local health (127.0.0.1)"
if curl -sf --max-time 5 http://127.0.0.1:3001/api/health; then
  echo ""
  echo "  OK — local"
else
  echo "  FAIL — local"
fi
echo ""

echo "3. Public health ($PUBLIC_IP — from VM; may fail due to Oracle hairpin NAT)"
if curl -sf --max-time 8 "http://${PUBLIC_IP}:3001/api/health"; then
  echo ""
  echo "  OK — public"
else
  echo "  FAIL from VM (normal on Oracle) — verify in browser: https://getbutler.xyz/api/health"
fi
echo ""

echo "4. iptables INPUT (first 15 rules)"
if command -v iptables >/dev/null 2>&1; then
  sudo iptables -L INPUT -n --line-numbers 2>/dev/null | head -20 || true
else
  echo "  (iptables not found)"
fi
echo ""

echo "5. butler-api status"
systemctl is-active butler-api 2>/dev/null || echo "  (not active)"
systemctl show butler-api -p ActiveState -p SubState -p MainPID -p User -p WorkingDirectory 2>/dev/null || true
echo ""
echo "5b. Node process"
ps aux 2>/dev/null | grep -E '[d]ist/server.mjs|[s]erver\.ts' || echo "  (no node API process)"
echo ""
echo "5c. Watchdog cron (kills API during boot if health != ok:true — fixed in latest scripts)"
crontab -l 2>/dev/null | grep -E 'oracle-watchdog|butler' || echo "  (no watchdog cron)"
if [[ -f /tmp/butler-watchdog.log ]]; then
  echo "  last watchdog log lines:"
  tail -5 /tmp/butler-watchdog.log 2>/dev/null | sed 's/^/    /'
fi
echo ""
echo "5d. journal (last 40 lines)"
sudo journalctl -u butler-api -n 40 --no-pager 2>/dev/null || true
echo ""

echo "6. Circle CLI"
if bash "$ROOT/scripts/circle.sh" --version 2>/dev/null; then
  echo "  OK"
else
  echo "  FAIL — run: cd $ROOT && npm run circle:install"
fi
echo ""

echo "Fix if nothing on :3001:"
echo "  git pull && bash scripts/oracle-recover.sh"
echo "  (If watchdog cron is old: it restarts API every minute during boot — pull fixes oracle-watchdog.sh)"
echo "  sudo systemctl restart butler-api && sleep 45 && curl -s http://127.0.0.1:3001/api/health"
echo "  Browser: https://getbutler.xyz/api/health"
