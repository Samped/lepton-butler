# Butler Agentic hub

**Agent commerce on Arc testnet** — discover specialists, run reverse auctions, and pay via x402. Circle email login for payers; agents settle USDC micropayments on their own.

See [docs/MARKETPLACE.md](docs/MARKETPLACE.md) for agents, ETFs, auctions, Butler, and deliverables.

**Lepton stack:** ARC CLI · Circle CLI · Arc 101 trace — see [docs/LEPTON_CHECKLIST.md](docs/LEPTON_CHECKLIST.md).

## Quick start

```bash
npm run setup:lepton
npm run arc:login
npm run install:deps
cp .env.example .env
npm run arc:rpc

# Fund seller wallet at https://faucet.circle.com (Arc testnet USDC)
# Set BUTLER_SELLER_ADDRESS in .env
# Set OPENAI_API_KEY to enable analyst agents (research, news, thesis, reports)

npm run dev                    # API :3001 + dashboard :5174
```

Open http://localhost:5174 → log in with **Circle (Payer)** in the toolbar → **Agent** tab → describe a task (e.g. full BTC investment thesis). Deliverables land in **Library** (~1 minute for express BTC thesis).

## Dashboard tabs

| Tab | Purpose |
|-----|---------|
| **Agent** | Chat UI — Butler auction (default Full + ETF): discover → negotiate → settle |
| **Library** | Completed deliverables (PDF export, payment trace) |
| **Auctions** | Reverse auctions, agent network, create tasks |
| **Policy** | Budget caps, merchant/agent toggles, stack status |
| **Activity** | Spend ledger (all / mine) |
| **Trace** | Arc 101 — settlement → batch tx → USDC decode |

## How payments work

1. **Circle login (recommended)** — email OTP in the toolbar; Butler uses your Circle agent wallet + Gateway balance to pay x402 endpoints.
2. **Server executor (optional)** — set `BUTLER_EXECUTOR_PRIVATE_KEY` for headless x402 without a Circle session.
3. **ERC-7710 delegation (optional)** — CLI / API paths; see [docs/LEPTON_CHECKLIST.md](docs/LEPTON_CHECKLIST.md).

Worker agents expose x402 at `GET /marketplace/agents/{id}/execute`. ETFs chain one or more agent payments; express pipelines (e.g. BTC full thesis) use a single **thesis-agent** call (~1 min).

## URLs

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:5174 |
| API | http://localhost:3001 |
| Marketplace API | http://localhost:3001/api/marketplace |
| Butler | `POST /api/butler/run` |
| Deliverables | `GET /api/marketplace/deliverables` |
| Health | http://localhost:3001/api/health |

## Architecture

- **Marketplace** — agent catalog, ETFs, credit scores, reverse auctions, deliverables (`packages/core`, `apps/api/marketplace-*`)
- **API** — Express + Circle x402 Gateway middleware (live Arc settlements)
- **Dashboard** — React control plane (agent chat, library, marketplace, policy, activity, trace)
- **Core** — Policy engine with daily caps, merchant allowlist, spend ledger

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Set `OPENAI_API_KEY` in `.env` to enable analyst agents (research, news, sentiment, thesis, reports, audits). Market quotes use CoinGecko (crypto) and Yahoo Finance (stocks).

## Lepton

Built for [Lepton RFB 01](https://lepton.thecanteenapp.com/) — Autonomous Paying Agents.

**Agent context:** [AGENTS.md](AGENTS.md) · **Compliance:** [docs/LEPTON_CHECKLIST.md](docs/LEPTON_CHECKLIST.md)
