#!/usr/bin/env bash
# Delete old GitHub deployment records (Vercel creates one per push).
# GitHub has no "show only latest" UI — prune inactive rows to clean the list.
#
# Usage:
#   bash scripts/prune-github-deployments.sh              # delete all but newest
#   bash scripts/prune-github-deployments.sh --dry-run    # preview only
#   KEEP=5 bash scripts/prune-github-deployments.sh       # keep newest 5
#
# Requires: gh auth login (token needs repo + repo_deployment scopes)
set -euo pipefail

REPO="${GITHUB_REPO:-Samped/bulter}"
KEEP="${KEEP:-1}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      echo "Usage: bash scripts/prune-github-deployments.sh [--dry-run]"
      echo "  KEEP=N (default 1) — number of newest deployments to retain"
      exit 0
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Run: gh auth login" >&2
  exit 1
fi

export GH_PAGER=cat

echo "Listing deployments for $REPO (newest first)…"
mapfile -t ALL_IDS < <(gh api --paginate "/repos/${REPO}/deployments" --jq '.[].id')

total="${#ALL_IDS[@]}"
if (( total <= KEEP )); then
  echo "Only $total deployment(s) — nothing to prune (KEEP=$KEEP)."
  exit 0
fi

to_delete=("${ALL_IDS[@]:KEEP}")
echo "Found $total deployments — keeping ${KEEP}, deleting ${#to_delete[@]}…"

deleted=0
skipped=0
failed=0

for dep_id in "${to_delete[@]}"; do
  latest_state="$(gh api "/repos/${REPO}/deployments/${dep_id}/statuses?per_page=1" --jq '.[0].state // empty' 2>/dev/null || true)"

  if [[ "$DRY_RUN" == true ]]; then
    echo "  [dry-run] would delete deployment $dep_id (state=${latest_state:-unknown})"
    ((deleted++)) || true
    continue
  fi

  if [[ "$latest_state" != "inactive" ]]; then
    gh api -X POST "/repos/${REPO}/deployments/${dep_id}/statuses" \
      -f state=inactive \
      -f description="Pruned by prune-github-deployments.sh" >/dev/null 2>&1 || true
    sleep 0.3
  fi

  if gh api -X DELETE "/repos/${REPO}/deployments/${dep_id}" >/dev/null 2>&1; then
    echo "  deleted $dep_id"
    ((deleted++)) || true
  else
    echo "  skip $dep_id (active or protected — delete manually if needed)" >&2
    ((skipped++)) || true
  fi

  sleep 0.4
done

echo ""
echo "Done. deleted=$deleted skipped=$skipped (kept newest $KEEP)"
if [[ "$DRY_RUN" == true ]]; then
  echo "Re-run without --dry-run to apply."
fi
