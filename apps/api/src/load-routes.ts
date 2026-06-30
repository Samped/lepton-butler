import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";
import type { SpendRecord } from "@butler/core";
import { handleGetLedger } from "./ledger-handlers.ts";
import { hasActiveUserSession } from "./user-session.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const WEB_URL = process.env.WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? 5174}`;

function resolveApiBase(): string {
  const configured = process.env.BUTLER_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return `http://127.0.0.1:${PORT}`;
}
const SELLER = (process.env.BUTLER_SELLER_ADDRESS ?? "0x933a2405f84c224be1ef373ba16e992e1f459682") as `0x${string}`;
const STATE_PATH = resolve(__dirname, "../../../.data/butler-state.json");
const MARKETPLACE_PATH = resolve(__dirname, "../../../.data/marketplace-state.json");

const yieldEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function loadRoutes(app: Express): Promise<void> {
  const [
    { createGatewayMiddleware },
    { formatUnits },
    arc,
    circleAgentDecode,
    circleAgentTrace,
    circleCli,
    circleConfig,
    core,
    agentRunner,
    marketplaceRoutes,
    ledgerPayer,
    agentServices,
  ] = await Promise.all([
    import("@circle-fin/x402-batching/server"),
    import("viem"),
    import("@butler/arc"),
    import("./circle-agent/decode-batch.ts"),
    import("./circle-agent/trace.ts"),
    import("./circle-cli.ts"),
    import("./circle-config.ts"),
    import("@butler/core"),
    import("./agent-runner.ts"),
    import("./marketplace-routes.ts"),
    import("./ledger-payer.ts"),
    import("./agent-services.ts"),
  ]);
  await yieldEventLoop();

  const { ARC_EIP155, GATEWAY_FACILITATOR, resolveArcRpc } = arc;
  const { decodeBatch } = circleAgentDecode;
  const { fetchSettlement, resolveBatchTx } = circleAgentTrace;
  const {
    arcCanteenAvailable,
    arcCanteenRpcUrl,
    circleCliInstalled,
    circleCliLoggedIn,
    circleCliRunnable,
    circleVersion,
    ensureCircleExecutor,
    getGatewayBalanceForApi,
    probeCircleCli,
  } = circleCli;
  const { loadCircleConfig, resolveCircleExecutorAddress, resolveCircleChain, useCircleCliPayments } = circleConfig;
  const {
    appendRecord,
    createDefaultPolicy,
    evaluateSpend,
    loadState,
    remainingDailyUsdc,
    saveState,
    loadMarketplaceState,
  } = core;
  const { runAgentTasks, agentRunReadiness } = agentRunner;
  const { registerMarketplaceRoutes } = marketplaceRoutes;
  const {
    enrichSpendPayer,
    getExecutorWalletAddress,
    resolveSessionActivityPayerAddresses,
    attributeLedgerRecords,
    filterMineRecords,
    applyJobAttribution,
    spendInitiatorFromQuery,
  } = ledgerPayer;
  const {
    buildResearchPayload,
    buildResearchSummary,
    buildSubscriptionAudit,
    buildUtilityQuote,
    fetchMarketQuote,
  } = agentServices;

type PaidRequest = Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER,
  facilitatorUrl: process.env.GATEWAY_FACILITATOR_URL ?? GATEWAY_FACILITATOR,
  networks: [ARC_EIP155],
});

function merchantHandler(
  merchantId: string,
  category: SpendRecord["category"],
  agent: SpendRecord["agent"],
  payloadFn: (req: PaidRequest) => Promise<unknown>
) {
  return async (req: PaidRequest, res: Response) => {
    const state = loadState(STATE_PATH);
    const amountUsdc = req.payment ? formatUnits(BigInt(req.payment.amount), 6) : "0";

    const decision = evaluateSpend(
      state.policy,
      { agent, merchantId, amountUsdc, category },
      state.records
    );

    if (!decision.allowed) {
      const payerMeta = enrichSpendPayer(req.payment?.payer);
      const record: SpendRecord = {
        id: crypto.randomUUID(),
        at: Math.floor(Date.now() / 1000),
        agent,
        category,
        merchantId,
        amountUsdc,
        settlementId: req.payment?.transaction,
        payerAddress: payerMeta.payerAddress,
        executorAddress: payerMeta.executorAddress,
        initiator: spendInitiatorFromQuery(req.query as Record<string, unknown>),
        status: "blocked",
        reason: decision.reason,
      };
      saveState(appendRecord(state, record), STATE_PATH);
      res.status(403).json({ error: decision.reason });
      return;
    }

    let data: unknown;
    try {
      data = await payloadFn(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Merchant service failed";
      res.status(503).json({ error: message });
      return;
    }

    const payerMeta = enrichSpendPayer(req.payment?.payer);
    const record: SpendRecord = {
      id: crypto.randomUUID(),
      at: Math.floor(Date.now() / 1000),
      agent,
      category,
      merchantId,
      amountUsdc,
      settlementId: req.payment?.transaction,
      payerAddress: payerMeta.payerAddress,
      executorAddress: payerMeta.executorAddress,
      initiator: spendInitiatorFromQuery(req.query as Record<string, unknown>),
      status: "settled",
    };
    saveState(appendRecord(state, record), STATE_PATH);

    const { payer, network, transaction } = req.payment ?? {};
    console.log(`[merchant] ${merchantId} ${amountUsdc} USDC payer=${payer} settlement=${transaction}`);

    res.json({
      merchantId,
      paid_by: payer,
      amount_usdc: amountUsdc,
      network,
      settlementId: transaction,
      data,
    });
  };
}

function briefFrom(req: PaidRequest): string {
  return String(req.query.brief ?? "");
}

// --- x402 merchants (live services) ---
app.get(
  "/merchants/research/summary",
  gateway.require("$0.01"),
  merchantHandler("research-summary", "apis", "research", (req) => buildResearchSummary(briefFrom(req)))
);

app.get(
  "/merchants/research/papers",
  gateway.require("$0.02"),
  merchantHandler("research-papers", "apis", "research", (req) => buildResearchPayload(briefFrom(req)))
);

app.get(
  "/merchants/data/price-feed",
  gateway.require("$0.001"),
  merchantHandler("price-feed", "apis", "research", (req) => fetchMarketQuote(briefFrom(req)))
);

app.get(
  "/merchants/bills/utility-quote",
  gateway.require("$0.05"),
  merchantHandler("utility-quote", "bills", "bills", (req) => buildUtilityQuote(briefFrom(req)))
);

app.get(
  "/merchants/bills/subscription-check",
  gateway.require("$0.03"),
  merchantHandler("subscription-check", "bills", "bills", (req) => buildSubscriptionAudit(briefFrom(req)))
);

// --- Butler control plane ---
app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Butler API</title>
<style>body{font-family:system-ui,sans-serif;background:#06080d;color:#f0f4fa;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#121820;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:2rem;max-width:420px;text-align:center}
a{color:#34d399}code{background:#0c1018;padding:.2rem .5rem;border-radius:6px;font-size:.85em}</style></head>
<body><div class="card"><h1>Butler API</h1><p>x402 merchant server on Arc testnet.</p>
<p><a href="${WEB_URL}">Open dashboard →</a></p>
<p><a href="/api/health">/api/health</a> · <a href="/api/policy">/api/policy</a></p>
<p style="color:#64748b;font-size:.85rem">Dashboard not loading? Check the Vite port in your terminal (e.g. <code>localhost:5175</code>) and set <code>WEB_URL</code> in <code>.env</code>.</p>
</div></body></html>`);
});

/** Lepton stack compliance status (ARC CLI, Circle CLI, circle-agent trace). */
app.get("/api/stack/status", (_req, res) => {
  try {
    res.json({
      leptonChecklist: true,
      arcCanteen: {
        installed: arcCanteenAvailable(),
        rpcUrl: arcCanteenRpcUrl(),
        docs: "https://github.com/the-canteen-dev/ARC-cli",
      },
      circleCli: {
        installed: circleCliInstalled(),
        runnable: circleCliRunnable(),
        loggedIn: circleCliLoggedIn(),
        version: circleVersion(),
        executorAddress: resolveCircleExecutorAddress(),
        docs: "https://developers.circle.com/agent-stack/circle-cli",
      },
      circleAgent: {
        traceApi: true,
        companion: "https://github.com/the-canteen-dev/circle-agent",
        arc101: "https://github.com/the-canteen-dev/circle-agent",
      },
      butler: {
        marketplace: true,
        gateway: GATEWAY_FACILITATOR,
        rpc: resolveArcRpc().replace(/\/\/[^@]+@/, "//***@"),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Stack status failed" });
  }
});

/** Arc 101 — settlement lookup (circle-agent compatible). */
app.get("/api/settlement/:id", async (req, res) => {
  const { status, body } = await fetchSettlement(req.params.id);
  res.status(status).type("application/json").send(body);
});

app.get("/api/batch-tx/:id", async (req, res) => {
  try {
    const result = await resolveBatchTx(req.params.id);
    if ("error" in result && result.error) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "batch-tx failed" });
  }
});

app.get("/api/decode-batch/:hash", async (req, res) => {
  try {
    const decoded = await decodeBatch(req.params.hash as `0x${string}`);
    res.json({
      ...decoded,
      blockNumber: decoded.blockNumber.toString(),
      entries: decoded.entries.map((e) => ({
        address: e.address,
        deltaRaw: e.delta.toString(),
        usdc: e.usdc,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "decode failed" });
  }
});

app.get("/api/policy", (_req, res) => {
  const state = loadState(STATE_PATH);
  res.json(state.policy);
});

app.put("/api/policy", (req, res) => {
  const state = loadState(STATE_PATH);
  state.policy = { ...state.policy, ...req.body, version: 1 };
  saveState(state, STATE_PATH);
  res.json(state.policy);
});

app.post("/api/policy/reset", (req, res) => {
  const owner = (req.body?.ownerAddress ?? "0x0000000000000000000000000000000000000001") as `0x${string}`;
  const state = { policy: createDefaultPolicy(owner), records: [] as SpendRecord[] };
  saveState(state, STATE_PATH);
  res.json(state.policy);
});

app.get("/api/ledger", (req, res) => {
  handleGetLedger(req, res, STATE_PATH, SELLER, MARKETPLACE_PATH);
});

app.get("/api/merchants", (_req, res) => {
  const state = loadState(STATE_PATH);
  res.json(state.policy.merchants);
});

app.get("/api/agents", (_req, res) => {
  const state = loadState(STATE_PATH);
  res.json(state.policy.agents);
});

function getExecutorAddress(): `0x${string}` | null {
  return getExecutorWalletAddress();
}

app.get("/api/agent/status", async (_req, res) => {
  try {
    const state = loadState(STATE_PATH);
    const circleExecutor = resolveCircleExecutorAddress();
    const executorAddress = circleExecutor ?? (hasActiveUserSession() ? null : getExecutorAddress());
    const readiness = agentRunReadiness();
    if (!circleExecutor && circleCliLoggedIn()) {
      void Promise.resolve().then(() => ensureCircleExecutor());
    }
    const gatewayBalanceUsdc = getGatewayBalanceForApi(circleExecutor);
    const activityPayerAddresses = resolveSessionActivityPayerAddresses(state.records);
    res.json({
      executorAddress,
      executorReady: readiness.canRun,
      sellerAddress: SELLER,
      circleCli: circleCliInstalled(),
      circleCliLoggedIn: circleCliLoggedIn(),
      circleExecutorAddress: circleExecutor,
      activityPayerAddresses,
      useCircleCli: useCircleCliPayments() || circleCliLoggedIn(),
      canRun: readiness.canRun,
      paymentMode: readiness.mode,
      gatewayBalanceUsdc,
      ...(readiness.reason ? { reason: readiness.reason } : {}),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Agent status failed" });
  }
});

app.post("/api/agent/run", async (req, res) => {
  try {
    if (!!req.body?.dryRun) {
      res.status(400).json({ error: "dryRun is disabled — agent runs execute real x402 payments" });
      return;
    }
    const forceX402 = !!req.body?.forceX402;
    const apiBase = resolveApiBase();
    const { mode, results } = await runAgentTasks({ apiBase, forceX402 });
    const state = loadState(STATE_PATH);
    res.json({
      mode,
      results,
      remainingDailyUsdc: remainingDailyUsdc(state.policy, state.records),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Agent run failed" });
  }
});

registerMarketplaceRoutes(app, {
  gateway,
  apiBase: resolveApiBase(),
  statePath: MARKETPLACE_PATH,
  policyStatePath: STATE_PATH,
  sellerAddress: SELLER,
});

  const state = loadState(STATE_PATH);
  saveState(state, STATE_PATH);
  console.log(`  dashboard: ${WEB_URL}`);
  console.log(`  seller: ${SELLER}`);
  console.log(`  circleCli: ${circleCliInstalled() ? "installed" : "MISSING — run bash scripts/ensure-circle-cli.sh in build"}`);
  console.log(`  merchants: /merchants/research/*, /merchants/bills/*, /merchants/data/*`);
  console.log(`  marketplace: /api/marketplace · /marketplace/agents/*/execute (x402)`);
}
