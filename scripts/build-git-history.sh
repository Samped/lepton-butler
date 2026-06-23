#!/usr/bin/env bash
# Builds incremental git history with human-readable commits.
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

if [[ ! -d .git ]]; then
  git init -b main
fi

# --- bootstrap ---
commit "start the lepton butler monorepo" package.json .gitignore
commit "add readme with quick start and stack overview" README.md
commit "document environment variables in env example" .env.example
commit "add agent context for arc canteen hackathons" AGENTS.md

# --- core policy ---
commit "define shared types for agents merchants and spend records" packages/core/package.json packages/core/tsconfig.json packages/core/src/types.ts
commit "implement policy engine with budget and merchant allowlists" packages/core/src/policy.ts
commit "add policy unit tests for spend limits" packages/core/src/policy.test.ts
commit "persist butler state and spend ledger to disk" packages/core/src/store.ts
commit "wire core package exports" packages/core/src/index.ts

# --- arc ---
commit "add arc testnet chain constants" packages/arc/package.json packages/arc/src/chain.ts
commit "resolve arc rpc from env and arc-canteen" packages/arc/src/rpc.ts packages/arc/src/index.ts

# --- delegation ---
commit "scaffold erc-7710 delegation package" packages/delegation/package.json packages/delegation/tsconfig.json
commit "build hybrid smart account clients for arc" packages/delegation/src/clients.ts packages/delegation/src/accounts.ts
commit "assemble delegation payloads for redeem" packages/delegation/src/build-delegation.ts
commit "redeem delegations on chain" packages/delegation/src/redeem.ts
commit "add delegation deploy helpers" packages/delegation/src/deploy.ts
commit "load arc env for delegation cli" packages/delegation/src/arc-env.ts packages/delegation/src/environment.ts
commit "export delegation package surface" packages/delegation/src/index.ts

# --- contracts ---
commit "add butler spend enforcer solidity contract" packages/contracts/foundry.toml packages/contracts/src/enforcers/ButlerSpendEnforcer.sol packages/contracts/src/interfaces/ICaveatEnforcer.sol
commit "add foundry deploy script for spend enforcer" packages/contracts/script/DeployButlerEnforcer.s.sol

# --- api shell ---
commit "bootstrap express api package" apps/api/package.json apps/api/tsconfig.json
commit "stand up express server with health and merchant routes" apps/api/src/server.ts
commit "persist circle payer config locally" apps/api/src/circle-config.ts
commit "format payment errors for the dashboard" apps/api/src/payment-errors.ts
commit "wrap circle cli for wallet login and payments" apps/api/src/circle-cli.ts

# --- payments ---
commit "run autonomous agent tasks via x402 or circle cli" apps/api/src/agent-runner.ts
commit "probe x402 endpoints before paying" apps/api/src/x402-probe.ts
commit "prepare browser-safe delegation setup flows" apps/api/src/delegation-prepare.ts
commit "resolve arc gateway client for settlements" apps/api/src/arc-client.ts
commit "record ledger entries after successful payments" apps/api/src/ledger-payer.ts

# --- circle agent trace ---
commit "vendor circle-agent trace helpers" vendor/circle-agent/buyer.ts vendor/circle-agent/decode-batch.ts vendor/circle-agent/server.ts vendor/circle-agent/package.json vendor/circle-agent/package-lock.json vendor/circle-agent/tsconfig.json vendor/circle-agent/README.md vendor/circle-agent/.gitignore
commit "add trace static assets for arc 101 walkthrough" vendor/circle-agent/public/
commit "integrate circle agent trace api" apps/api/src/circle-agent/trace.ts
commit "decode batch transactions for usdc transfers" apps/api/src/circle-agent/decode-batch.ts

# --- marketplace core ---
commit "define marketplace agents etfs and scoring" packages/core/src/marketplace.ts
commit "persist marketplace jobs and auctions" packages/core/src/marketplace-store.ts
commit "add auction types and award logic" packages/core/src/auction.ts
commit "route tasks to agent roles" packages/core/src/task-router.ts packages/core/src/agent-tasks.ts packages/core/src/agent-registry.ts

# --- marketplace api ---
commit "run periodic auction engine ticks" apps/api/src/auction-engine.ts
commit "orchestrate multi-agent etf pipelines" apps/api/src/marketplace-orchestrator.ts
commit "expose marketplace rest routes" apps/api/src/marketplace-routes.ts
commit "create marketplace tasks from briefs" apps/api/src/marketplace-task.ts
commit "implement payer agent discover auction settle flow" apps/api/src/payer-agent.ts

# --- intelligence ---
commit "call openai for agent deliverables" apps/api/src/openai-client.ts apps/api/src/agent-services.ts
commit "plan agent steps from natural language briefs" apps/api/src/openai-planner.ts
commit "merge multi-agent outputs into one deliverable" apps/api/src/deliverable-combine.ts
commit "register external x402 agents from config" apps/api/src/external-agent-registry.ts config/external-agents.example.json config/external-agents.seed.json

# --- context ---
commit "store session context for agent runs" apps/api/src/context-store.ts

# --- web shell ---
commit "bootstrap react dashboard with vite" apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/src/main.tsx apps/web/src/vite-env.d.ts
commit "layout app shell and shared components" apps/web/src/App.tsx apps/web/src/components.tsx apps/web/src/icons.tsx apps/web/src/format.ts apps/web/src/ErrorBoundary.tsx
commit "add global styles and design tokens" apps/web/src/styles.css
commit "typed api client for butler backend" apps/web/src/api.ts

# --- web features ---
commit "circle payer login panel in toolbar" apps/web/src/circle/CircleLoginPanel.tsx
commit "agent chat tab for payer-driven auctions" apps/web/src/agent/AgentChatView.tsx
commit "marketplace view with agent catalog" apps/web/src/marketplace/MarketplaceView.tsx
commit "auction panel with live status" apps/web/src/marketplace/AuctionPanel.tsx
commit "create task modal with quality tier and budget" apps/web/src/marketplace/CreateTaskModal.tsx
commit "open registry panel for external agents" apps/web/src/marketplace/OpenRegistryPanel.tsx
commit "library view for deliverables" apps/web/src/deliverables/DeliverablesView.tsx
commit "render deliverable markdown and json" apps/web/src/deliverables/DeliverableContent.tsx apps/web/src/deliverables/format.ts apps/web/src/deliverables/utils.ts
commit "paper document layout for exports" apps/web/src/deliverables/PaperDocument.tsx apps/web/src/deliverables/pdfExport.ts apps/web/src/deliverables/combine.ts
commit "payment trace tab for arc 101" apps/web/src/trace/PaymentTrace.tsx apps/web/src/trace/StackStatus.tsx
commit "standalone html build for demos" apps/web/standalone/index.html

# --- clis ---
commit "add butler agent cli runner" apps/agent/package.json apps/agent/tsconfig.json apps/agent/src/run.ts
commit "add delegation cli for deploy setup and pay" apps/delegation/package.json apps/delegation/src/deploy.ts apps/delegation/src/setup.ts apps/delegation/src/pay.ts

# --- scripts ---
commit "add circle cli install and wrapper scripts" scripts/circle.sh scripts/install-circle-cli.py scripts/circle-wallet-setup.sh
commit "bootstrap foundry and npm dependencies" scripts/bootstrap-foundry.sh scripts/bootstrap-install.sh scripts/install-deps.py scripts/repair-deps.py
commit "setup lepton stack arc and circle" scripts/setup-lepton-stack.sh scripts/load-arc-rpc.sh scripts/deploy-arc-delegation.sh

# --- docs ---
commit "document system architecture" docs/ARCHITECTURE.md
commit "document marketplace agents and auctions" docs/MARKETPLACE.md
commit "add lepton hackathon compliance checklist" docs/LEPTON_CHECKLIST.md
commit "add distribution and deployment notes" docs/DISTRIBUTION.md

# --- fixes (recent work) ---
commit "ignore vendor git metadata and build artifacts" .gitignore
commit "fix circle cli readiness when wallet status is slow" apps/api/src/circle-cli.ts

echo ""
echo "Done — $(git rev-list --count HEAD) commits on $(git branch --show-current)"
