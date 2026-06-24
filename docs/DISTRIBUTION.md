# Distribution Bootstrap alignment

Butler implements the [Distribution Bootstrap for Payments Founders](https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html) thesis: **agents that pay create distribution for creators and API providers**.

---

## Thesis

Traditional distribution (ads, subscriptions) does not work for machine consumers. x402 + stablecoin L1s (Arc) enable **per-use nanopayments**. Autonomous agents with wallets and budgets are the distribution layer.

Butler is that layer — with **human-in-the-loop delegation** so users retain authority while agents execute within policy.

---

## Bootstrap primitives → Butler features

| Primitive | Butler implementation |
|-----------|----------------------|
| **Machine-readable paywalls** | x402 on `/merchants/*` and `/marketplace/agents/*/execute` |
| **Agent wallets** | Circle CLI agent wallets; Gateway deposit |
| **Budget / policy** | `packages/core` — daily caps, merchant allowlist |
| **Autonomous purchase** | Agent tab (`/api/butler/run`), ETFs, auctions |
| **Deliverables** | Library — `GET /api/marketplace/deliverables` |
| **Settlement trace** | Activity ledger + Arc 101 Trace tab |
| **Creator payout** | `BUTLER_SELLER_ADDRESS` receives USDC per settlement |
| **Delegated authority** | ERC-7710 — user signs once; executor pays from Hybrid SC |
| **Enforced scope** | `ButlerSpendEnforcer` on-chain caveats mirror off-chain policy |

---

## Agent roles (distribution channels)

| Agent | Categories | Example |
|-------|------------|---------|
| **research** | apis | marketplace worker agents, legacy `/merchants/research/*` |
| **bills** | bills | report/thesis agents, `/merchants/bills/*` |

**Marketplace worker agents** (15) are the primary distribution surface — each x402 call pays `BUTLER_SELLER_ADDRESS` and records in the ledger. ETFs bundle multiple agent payments into one workflow.

Each policy agent role has its own daily sub-limit under the owner's global cap.

---

## Payment flow (distribution event)

```
User logs in Circle payer (or enables ERC-7710 delegation)
        ↓
Payer-agent / orchestrator evaluates policy → allowed merchant
        ↓
Pay via Circle CLI OR x402 OR delegation redeem
        ↓
USDC to seller (BUTLER_SELLER_ADDRESS)
        ↓
Ledger + Library deliverable + optional Arc 101 trace
```

Every settled payment is a **distribution event**: value moves from buyer (user Hybrid SC or agent Gateway balance) to seller.

---

## Why delegation matters for distribution

Raw agent wallets scare users ("the bot has my keys"). ERC-7710 delegation:

- User keeps ownership of funds in Hybrid SC
- Delegation is **revocable** and **caveat-bound** (amount, time, enforcer)
- Butler executor can only pay within policy — matching Bootstrap need for **trusted autonomous commerce**

---

## Extending Butler for your vertical

To adapt Butler for a Distribution Bootstrap pitch (e.g. citations, APIs, feeds):

1. Add merchants under `/merchants/<vertical>/<resource>` with x402 pricing
2. Register in policy `merchants` array with category + agent role
3. Point seller address to creator payout wallet
4. Optionally add enforcer rules in `ButlerSpendEnforcer` for on-chain limits

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [LEPTON_CHECKLIST.md](./LEPTON_CHECKLIST.md).
