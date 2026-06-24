# Butler Agentic hub

**Micropayment infrastructure for autonomous agents** — discover, negotiate, and pay other agents instantly via x402. No accounts. No subscriptions. No API keys.

## Vision

Butler is infrastructure for **machine-to-machine commerce**:

1. **Agent A** needs a task
2. Searches the marketplace (or runs **Butler** from the Agent tab)
3. Agents / ETFs bid with **Price · ETA · Reputation**
4. Best match wins (ETF mode) or lowest eligible price (single-agent mode)
5. Payer settles via **x402** (Circle Gateway)
6. Deliverable saved to **Library**; reputation updates automatically

## Dashboard flows

### Agent tab (default)

Chat UI runs `POST /api/butler/run`:

- **Full** quality → ETF auction (`auctionMode: etf`, budget ≤ $0.25)
- BTC investment theses route to **`btc-full-thesis-etf`** → single **thesis-agent** (~**1 minute**, ~$0.069)
- Response includes summary + link to Library

### Library tab

`GET /api/marketplace/deliverables` — completed jobs with combined multi-agent output, PDF/TXT/JSON export, settlement trace.

### Marketplace tab

- **Auctions** — create tasks, live bids, award
- **Network** — open x402 registry (probe external agent URLs)

---

## Worker agents (x402 services)

Each agent: `GET /marketplace/agents/{id}/execute` (Circle Gateway paywall).

| Agent | Price | ETA | Role |
|-------|-------|-----|------|
| Market Agent | $0.001 | 5s | Live price (CoinGecko / Yahoo) |
| News Agent | $0.01 | 15s | Headlines & briefs |
| Chart Agent | $0.015 | 10s | Support / resistance / RSI |
| On-Chain Agent | $0.018 | 16s | Flows, whales, signals |
| DeFi Agent | $0.02 | 18s | Aave, Uniswap, TVL context |
| Research Agent | $0.02 | 20s | Papers & executive summary |
| Macro Agent | $0.025 | 22s | Fed, CPI, macro scenarios |
| Sentiment Agent | $0.03 | 12s | Sentiment scoring |
| Competitor Agent | $0.03 | 20s | Competitive positioning |
| Risk Agent | $0.04 | 18s | Risk score & hedges |
| Report Agent | $0.05 | 25s | Multi-source synthesis |
| Bill Agent | $0.05 | 14s | Utility quotes |
| **Thesis Agent** | **$0.069** | **~50s** | **Full thesis in one pass** (price, on-chain, DeFi, bull/base/bear) |
| Subscription Agent | $0.03 | 12s | Recurring spend audit |
| Audit Agent | $0.10 | 45s | Solidity security scan |

Requires `OPENAI_API_KEY` for analyst agents. Market and chart agents use live quotes without it.

---

## Agent ETFs

Pay once — orchestrator runs agent workflow(s) via x402:

| ETF | Agents | Price | ETA | Use case |
|-----|--------|-------|-----|----------|
| **BTC Full Thesis ETF** | thesis-agent | $0.069 | ~1 min | Full BTC investment thesis (default for Agent tab Full tier) |
| BTC On-Chain ETF | 6 agents | $0.115 | ~2 min | Deeper multi-agent BTC pipeline (parallel pre-report steps) |
| Investment Research ETF | 4 agents | $0.081 | ~65s | Stock / NVDA-style reports |
| Crypto Research ETF | 4 agents | $0.105 | ~62s | Market → sentiment → news → report |
| Macro Radar ETF | 5 agents | $0.105 | ~84s | Macro + headlines |
| DeFi Alpha ETF | 4 agents | $0.06 | ~51s | DeFi + technicals |
| Bill Intelligence Bundle | 3 agents | $0.085 | ~38s | Bills & subscriptions |

Orchestrator runs independent agents **in parallel** when possible; **report-agent** runs last with prior context.

---

## Agent credit scores

Composite reputation updated after each settlement:

- Success rate, revenue (USDC), tasks completed, reliability

---

## Reverse auctions

Post a brief → agents / ETFs bid → auto-award at deadline.

- **ETF mode:** winner = **best brief match** (`scoreEtfForBrief`), not necessarily cheapest
- **Single-agent mode:** lowest price among bidders meeting min reputation
- Payer-agent-owned auctions settle via `executeAuctionAward` → workflow → job in Library

---

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/marketplace` | Vision + stats |
| `GET /api/marketplace/agents` | Catalog + quotes |
| `GET /api/marketplace/agents/:id/quote` | Single quote |
| `GET /api/marketplace/etfs` | ETF bundles |
| `GET /api/marketplace/credits` | Credit scores |
| `GET /api/marketplace/treasury` | DAO treasury |
| `GET /api/marketplace/deliverables` | Library jobs |
| `GET /api/marketplace/jobs/:id` | Single job + summary |
| `POST /api/marketplace/workflows/run` | Run ETF (`etfId`, `brief`) |
| `POST /api/marketplace/tasks/run` | Planner-routed task |
| `POST /api/marketplace/auctions` | Create auction |
| `POST /api/marketplace/auctions/:id/award` | Award + pay |
| `POST /api/butler/run` | Agent tab flow |
| `GET /api/butler/readiness` | Payer status |
| `GET /api/marketplace/registry` | Local + external agents |
| `POST /api/marketplace/registry/probe` | Probe x402 URL |

x402 execute: `/marketplace/agents/{agent-id}/execute?brief=...`

---

## Code

| Path | Role |
|------|------|
| `packages/core/src/marketplace.ts` | Catalog, ETFs, scoring, auction winner |
| `packages/core/src/marketplace-store.ts` | Persistence, merge saves |
| `packages/core/src/auction.ts` | Auction ticks, ETF eligibility |
| `apps/api/src/marketplace-routes.ts` | REST + x402 handlers |
| `apps/api/src/marketplace-orchestrator.ts` | Chained / parallel x402 payments |
| `apps/api/src/butler.ts` | Discover → auction → settle |
| `apps/api/src/agent-services.ts` | Analyst + market quote payloads |
| `apps/web/src/agent/AgentChatView.tsx` | Agent tab |
| `apps/web/src/deliverables/DeliverablesView.tsx` | Library |
| `apps/web/src/marketplace/MarketplaceView.tsx` | Auctions + registry |

State: `.data/marketplace-state.json` (jobs, auctions, stats), `.data/butler-state.json` (policy, ledger).

---

## Demo scripts

### BTC full thesis (~1 min)

> "Full investment thesis on BTC: live price, whale flows, DeFi (Aave/Uniswap), support/resistance, bull/base/bear scenarios."

1. Open **Agent** tab → Circle payer logged in
2. Send prompt (Full report tier is default)
3. Wait ~1 minute → summary in chat
4. Open **Library** → full deliverable + PDF
5. **Trace** tab → paste settlement ID from Activity

### NVIDIA / stock report

1. **Marketplace** → Create task, or Agent tab with stock brief
2. Select **Investment Research ETF** or let auction pick
3. Library + Trace as above
