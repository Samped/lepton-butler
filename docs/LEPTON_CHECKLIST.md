# Lepton RFB checklist — Butler compliance map

Butler is a **full-stack autonomous paying agent** that satisfies every Lepton / Canteen onboarding item while keeping our differentiators: **ERC-7710 delegation**, policy engine, wallet-connect dashboard, and one-click agent runs.

| # | Requirement | Butler implementation |
|---|-------------|---------------------|
| **03** | [ARC CLI](https://github.com/the-canteen-dev/ARC-cli) (`arc-canteen`) | `npm run setup:lepton`, `npm run arc:login`, `npm run arc:context`, `resolveArcRpc()` |
| **04** | [Circle CLI](https://developers.circle.com/agent-stack/circle-cli) | `npm run circle:login`, `scripts/circle-wallet-setup.sh`, `circle-cli` agent mode |
| **05** | [Arc 101 / circle-agent](https://github.com/the-canteen-dev/circle-agent) | Trace APIs + dashboard **Trace** tab, `vendor/circle-agent` |
| **06** | [Distribution Bootstrap](https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html) | `docs/DISTRIBUTION.md` — Butler as paying-agent distribution layer |

---

## One-command setup

```bash
npm run setup:lepton    # ARC CLI, Circle CLI, circle-agent vendor, RPC → .env
cp .env.example .env
npm run install:deps
npm run dev
```

Open **http://localhost:5174** → **Circle payer** login (toolbar) → **Agent** tab → run a task. Optional: ERC-7710 delegation via CLI (`npm run delegation:setup`).

---

## 03 — ARC CLI (`arc-canteen`)

**Why:** Authenticated Arc testnet RPC, Canteen agent context, hackathon compliance.

```bash
# Install (requires uv)
uv tool install "git+https://github.com/the-canteen-dev/ARC-cli.git"
arc-canteen login
arc-canteen shell-init >> ~/.bashrc   # adds $RPC to shell

# Butler shortcuts
npm run arc:login      # arc-canteen login
npm run arc:context    # arc-canteen context sync
npm run arc:rpc        # print RPC URL → ARC_TESTNET_RPC
```

**Code paths:**
- `packages/arc/src/rpc.ts` — `resolveArcRpc()` prefers `ARC_TESTNET_RPC`, then `arc-canteen rpc-url`, then public RPC
- `scripts/load-arc-rpc.sh` — sources `~/.arc-canteen/env`
- `GET /api/health` and `GET /api/stack/status` — report active RPC

**Verify:**
```bash
arc-canteen rpc-url
curl -s localhost:3001/api/stack/status | jq .arcCanteen
```

---

## 04 — Circle CLI

**Why:** Official agent wallet, Gateway deposits, `circle services pay` for x402 merchants.

```bash
npm install -g @circle-fin/cli
npm run circle:login              # circle wallet login <email> --testnet
bash scripts/circle-wallet-setup.sh

# 1) Fund the agent wallet on Arc testnet (Circle faucet, 20 USDC)
circle wallet fund --address <AGENT> --chain ARC-TESTNET

# 2) Deposit into Gateway for x402 nanopayments (direct on Arc testnet)
circle gateway deposit --amount 5 --address <AGENT> --chain ARC-TESTNET --method direct

# 3) Confirm Gateway balance (Arc Testnet row should be > 0)
circle gateway balance --address <AGENT> --chain ARC-TESTNET --all

# Pay a Butler merchant directly
circle services pay http://127.0.0.1:3001/marketplace/agents/news-agent/execute \
  --address <AGENT> --chain ARC-TESTNET
```

**Env (`.env`):**
```env
CIRCLE_EXECUTOR_ADDRESS=0x...
CIRCLE_CHAIN=ARC-TESTNET
BUTLER_USE_CIRCLE_CLI=true   # agent uses CLI instead of raw private key
```

**Code paths:**
- `apps/api/src/circle-cli.ts` — spawn helpers
- `apps/api/src/agent-runner.ts` — `circle-cli` payment mode when `BUTLER_USE_CIRCLE_CLI=true`
- `GET /api/agent/status` — reports `circleCli`, `useCircleCli`, `executorReady`

**Payment priority (agent run):**
1. ERC-7710 delegation redeem (if `.data/delegation.json` active)
2. Circle CLI `services pay` (if `BUTLER_USE_CIRCLE_CLI=true`)
3. Gateway x402 client (executor private key)

---

## 05 — Arc 101 / circle-agent companion

**Why:** Judges expect the six-step payment trace (settlement → batch tx → decode).

**API (circle-agent compatible):**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/settlement/:id` | Gateway transfer status |
| `GET /api/batch-tx/:id` | Resolve on-chain batch tx from settlement |
| `GET /api/decode-batch/:hash` | Decode USDC movements in batch tx |

**Dashboard:** **Trace** tab — paste settlement ID from Activity ledger, walk Arc 101 steps.

**Reference clone:**
```bash
git clone https://github.com/the-canteen-dev/circle-agent.git vendor/circle-agent
```

**Code paths:**
- `apps/api/src/circle-agent/decode-batch.ts`
- `apps/api/src/circle-agent/trace.ts`
- `packages/arc/src/chain.ts` — `PINNED_BATCH_TX`, `GATEWAY_WALLET_ARC`

---

## 06 — Distribution Bootstrap

Butler maps to Distribution Bootstrap primitives — see [docs/DISTRIBUTION.md](./DISTRIBUTION.md).

| Bootstrap item | Butler feature |
|----------------|----------------|
| Paying agents | Policy-scoped autonomous payer |
| x402 merchants | `/merchants/*` API with Gateway middleware |
| Wallet + delegation | Sign once, agent pays within caveats |
| Traceability | Ledger + Arc 101 trace |
| Creator / seller payouts | Seller address receives USDC per settlement |

---

## Butler differentiators (winning narrative)

1. **ERC-7710 delegation** — user funds Hybrid SC; Butler executor redeems within `ButlerSpendEnforcer` caveats (mirrors off-chain policy).
2. **Professional dashboard** — Agent chat, Library deliverables, marketplace auctions, policy, Arc 101 trace.
3. **Dual payment rails** — Circle CLI payer (primary), x402 executor key, optional ERC-7710 delegation.
4. **Full Lepton stack** — not a fork of circle-agent; composes ARC CLI + Circle CLI + trace + delegation.

---

## Pre-submission checklist

- [x] `npm run setup:lepton` — scripts + docs + vendor circle-agent
- [x] Foundry bootstrap — `npm run delegation:bootstrap` (forge-std + delegation-framework)
- [x] Arc 101 trace APIs — `/api/settlement`, `/api/batch-tx`, `/api/decode-batch` + Trace tab
- [x] Dashboard — wallet connect, delegation flow, policy, agent run, stack status
- [x] `resolveArcRpc()` — reads `~/.arc-canteen/env` + `arc-canteen rpc-url`
- [ ] `arc-canteen login` + authenticated RPC in `.env`
- [ ] `npm run delegation:deploy:forge` + `BUTLER_SPEND_ENFORCER_ADDRESS` in `.env`
- [ ] Enable Butler (dashboard) or `npm run delegation:setup`
- [ ] Fund Hybrid SC + set `BUTLER_EXECUTOR_PRIVATE_KEY` on API
- [ ] Run agent — at least one merchant settles
- [ ] Circle CLI login + executor *(optional — see checklist 04)*

---

## Demo script (3 minutes)

1. **Stack** — Policy tab → Lepton stack panel (ARC + Circle CLI green).
2. **Payer** — Toolbar Circle login; fund Gateway USDC if needed.
3. **Agent** — Send a brief (e.g. BTC full thesis); show ~1 min settlement + Library deliverable.
4. **Activity** — Ledger with settlement IDs (`Mine` filter for user-initiated).
5. **Trace** — Paste settlement ID; Gateway → batch tx → USDC decode.
6. **Fallback** — `circle services pay` one marketplace agent from terminal (Circle CLI).

---

## Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — delegation + policy flows
- [DISTRIBUTION.md](./DISTRIBUTION.md) — Distribution Bootstrap alignment
- [../AGENTS.md](../AGENTS.md) — arc-canteen agent context for local development
- [../README.md](../README.md) — quick start
