#!/usr/bin/env bash
# Vercel install — delegate to repo script that adds @butler/web to workspaces.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$ROOT/scripts/vercel-install.sh"
