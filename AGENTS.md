# Agent context (arc-canteen)

This file is synced with [ARC CLI](https://github.com/the-canteen-dev/ARC-cli) agent context for Lepton / Canteen hackathons.

Run `npm run arc:context` after `arc-canteen login` to refresh from Canteen.

---

## Project: Lepton Butler

**One-liner:** Autonomous paying agent on Arc testnet with ERC-7710 delegation, Circle x402 USDC micropayments, policy-enforced budgets, and an agent-to-agent marketplace.

**Chain:** Arc testnet `5042002`  
**USDC:** `0x3600000000000000000000000000000000000000`  
**Gateway:** `https://gateway-api-testnet.circle.com`

---

## Monorepo layout

```
packages/core/       Policy, marketplace catalog, auctions, ledger (.data/*)
packages/arc/        Chain constants, Gateway, resolveArcRpc()
packages/delegation/ ERC-7710 TS (build, redeem, deploy)
packages/contracts/  ButlerSpendEnforcer.sol
apps/api/            Express + x402 + marketplace + payer-agent + trace
apps/web/            React dashboard (Agent, Library, Marketplace, Policy, Activity, Trace)
apps/agent/          CLI orchestrator
apps/delegation/     delegation CLI (deploy, setup, pay)
```

---

## Key commands

```bash
npm run setup:lepton     # Install Lepton stack (ARC CLI, Circle CLI, vendor)
npm run dev              # API :3001 + web :5174
npm run delegation:deploy:forge
npm run agent            # CLI agent run
npm run arc:rpc          # Arc RPC from arc-canteen
```

---

## Dashboard (primary UX)

| Tab | What it does |
|-----|----------------|
| **Agent** | Default. Chat + payer-agent auction (Full tier → ETF pipeline). ~1 min for BTC full thesis. |
| **Library** | `GET /api/marketplace/deliverables` — completed jobs, PDF export |
| **Marketplace** | Auctions, open x402 registry, manual task creation |
| **Policy** | Budget, merchants, agents, Lepton stack panel |
| **Activity** | Ledger (`scope=all` or `mine`) |
| **Trace** | Arc 101 settlement trace |

Circle payer login: toolbar **Payer** chip (email OTP), not a sidebar wallet flow.

---

## API surface

| Route | Description |
|-------|-------------|
| `GET /api/health` | Live mode, chain, seller, RPC |
| `GET /api/stack/status` | Lepton checklist compliance |
| `GET /api/policy` | Budget + merchants + agents |
| `GET /api/ledger` | Spend records (`?scope=mine`) |
| `GET/POST /api/delegation/*` | ERC-7710 setup (prepare/finish for browser) |
| `POST /api/agent/run` | Legacy demo merchant loop |
| `GET /api/marketplace/agents` | Worker agent catalog + quotes |
| `GET /api/marketplace/etfs` | ETF bundles |
| `GET /api/marketplace/deliverables` | Completed jobs for Library |
| `POST /api/marketplace/workflows/run` | Run ETF workflow |
| `POST /api/marketplace/tasks/run` | AI-routed task (auto/manual) |
| `POST /api/marketplace/auctions` | Reverse auction |
| `POST /api/payer-agent/run` | Discover → auction → settle (Agent tab) |
| `GET /api/payer-agent/readiness` | Payer configured? |
| `GET /api/settlement/:id` | Arc 101 — Gateway transfer |
| `GET /api/batch-tx/:id` | Settlement → batch tx |
| `GET /api/decode-batch/:hash` | Batch tx USDC decode |

x402 worker paths: `GET /marketplace/agents/{agent-id}/execute`

---

## Marketplace highlights

- **15 worker agents** — news, market, research, sentiment, chart, **thesis**, report, audit, defi, macro, onchain, competitor, risk, bill, subscription
- **7 ETFs** — including `btc-full-thesis-etf` (single thesis-agent, ~$0.069, ~1 min) and `btc-onchain-etf` (6-agent pipeline)
- **Reverse auctions** — ETF mode picks **best brief match** (not always cheapest); single-agent mode by price + reputation
- **Open registry** — probe/register external x402 agents (`/api/marketplace/registry/*`)

---

## Payment modes (agent runner / marketplace)

1. **circle-cli** — `circle services pay` when logged in (default for dashboard payer)
2. **x402** — `GatewayClient` with `BUTLER_EXECUTOR_PRIVATE_KEY`
3. **delegation** — `redeemDelegations` from Hybrid SC (requires `.data/delegation.json`)

---

## Environment

Copy `.env.example` → `.env`. Critical keys:

- `BUTLER_SELLER_ADDRESS` — receives merchant payments
- `OPENAI_API_KEY` — required for intelligence agents (thesis, research, news, etc.)
- `BUTLER_EXECUTOR_PRIVATE_KEY` or Circle login + `CIRCLE_EXECUTOR_ADDRESS`
- `BUTLER_OWNER_PRIVATE_KEY` — delegation signer (CLI setup)
- `ARC_TESTNET_RPC` — or use `arc-canteen rpc-url`
- `BUTLER_SPEND_ENFORCER_ADDRESS` — after `delegation:deploy:forge`

---

## Lepton compliance

Full checklist: [docs/LEPTON_CHECKLIST.md](docs/LEPTON_CHECKLIST.md)

- **03** ARC CLI — `resolveArcRpc()`, `setup-lepton-stack.sh`
- **04** Circle CLI — `circle-cli.ts`, `BUTLER_USE_CIRCLE_CLI`
- **05** circle-agent — trace APIs + web Trace tab
- **06** Distribution Bootstrap — [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)

---

## x402 merchants (legacy demo)

Base URL: `http://localhost:3001`

- `/merchants/research/summary` — $0.01
- `/merchants/research/papers` — $0.02
- `/merchants/data/price-feed` — $0.001
- `/merchants/bills/utility-quote` — $0.05
- `/merchants/bills/subscription-check` — $0.03

Marketplace worker agents map to these merchants for policy checks.

---

## Do not

- Bundle `@metamask/smart-accounts-kit` in the web app — browser uses API prepare/finish only
- Commit `.env` or private keys
- Use mainnet keys on Arc testnet
- Import `@butler/core/marketplace` in web without Vite alias (use relative path to `packages/core/src/marketplace.ts` or configured alias)
