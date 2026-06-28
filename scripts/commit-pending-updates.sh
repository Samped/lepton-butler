#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

commit() {
  local msg="$1"
  shift
  if [[ $# -eq 0 ]]; then return 0; fi
  git add "$@"
  if git diff --cached --quiet; then
    echo "skip (empty): $msg"
    return 0
  fi
  git commit -m "$msg"
  echo "✓ $msg"
}

commit "Detect solidity source in briefs so audits do not route to on-chain agents" \
  packages/core/src/brief-intent.ts

commit "Add express audit and bill routes with brief-tier single auction mode" \
  packages/core/src/auction.ts

commit "Give new local agents a credit floor so they can still bid on auctions" \
  packages/core/src/marketplace-store.ts

commit "Run audit agent under bills policy so completed payments are not rejected" \
  packages/core/src/marketplace.ts

commit "Stash oversized briefs on the server for audit and long paste jobs" \
  apps/api/src/context-store.ts

commit "Shape audit and utility bill agent responses as typed deliverables" \
  apps/api/src/agent-services.ts

commit "Parse agent disabled errors out of circle cli payment failures" \
  apps/api/src/payment-errors.ts

commit "Pull stashed brief text when marketplace orchestrator runs a job" \
  apps/api/src/marketplace-orchestrator.ts

commit "Update marketplace task helpers for butler naming and express fallback" \
  apps/api/src/marketplace-task.ts

commit "Tweak deliverable merge for audit and bill document types" \
  apps/api/src/deliverable-combine.ts

commit "Improve x402 probe handling for external agent price discovery" \
  apps/api/src/x402-probe.ts

commit "Replace payer-agent orchestrator with butler module" \
  apps/api/src/butler.ts \
  apps/api/src/payer-agent.ts

commit "Add butler run and readiness routes with payer-agent aliases" \
  apps/api/src/marketplace-routes.ts

commit "Honor butlerOwned flag when the auction engine auto-awards jobs" \
  apps/api/src/auction-engine.ts

commit "Label butler-initiated ledger entries for activity filtering" \
  apps/api/src/ledger-payer.ts

commit "Add audit deliverable detection helpers for the library" \
  apps/web/src/deliverables/audit.ts

commit "Add utility bill deliverable detection helpers for the library" \
  apps/web/src/deliverables/bill.ts

commit "Render audit findings and bill quotes in dedicated library blocks" \
  apps/web/src/deliverables/DeliverableContent.tsx

commit "Show cleaner titles for audit and bill items in the library list" \
  apps/web/src/deliverables/DeliverablesView.tsx

commit "Improve paper export layout for audit and bill deliverables" \
  apps/web/src/deliverables/PaperDocument.tsx

commit "Recognize audit and bill types when combining deliverable sections" \
  apps/web/src/deliverables/combine.ts

commit "Style audit contract panels and bill quote cards in the library" \
  apps/web/src/styles.css

commit "Mirror audit and bill express routing hints in the web brief parser" \
  apps/web/src/brief-intent.ts

commit "Rename payer-agent client calls to butler with legacy aliases" \
  apps/web/src/api.ts

commit "Add file attach for solidity audits and show butler phase updates in chat" \
  apps/web/src/agent/AgentChatView.tsx

commit "Run butler from create task modal and refresh auction copy" \
  apps/web/src/marketplace/CreateTaskModal.tsx \
  apps/web/src/marketplace/MarketplaceView.tsx

commit "Clarify butler timeout and busy-state messages in the dashboard" \
  apps/web/src/format.ts

commit "Add bracket B logo asset for sidebar and favicon" \
  apps/web/public/logo.png

commit "Show logo and Agentic hub branding in the app shell" \
  apps/web/src/App.tsx \
  apps/web/index.html

commit "Document butler routes and agent tab in agent context" \
  AGENTS.md \
  .env.example

NEW=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
echo ""
echo "Done — $NEW new commits on $(git branch --show-current)"
