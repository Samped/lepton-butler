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
sudo journalctl -u butler-api -n 20 --no-pager 2>/dev/null || true
echo ""

echo "6. Circle CLI"
if bash "$ROOT/scripts/circle.sh" --version 2>/dev/null; then
  echo "  OK"
else
  echo "  FAIL — run: cd $ROOT && npm run circle:install"
fi
echo ""

echo "Fix if nothing on :3001:"
echo "  cd $ROOT && npm run circle:install && npm run install:render"
echo "  sudo pkill -9 -f dist/server.mjs; sudo fuser -k 3001/tcp; sleep 2"
echo "  sudo systemctl restart butler-api && sleep 5"
echo "  curl -s http://127.0.0.1:3001/api/health"
echo "  Browser: https://getbutler.xyz/api/health"
