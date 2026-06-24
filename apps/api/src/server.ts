import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { formatUnits } from "viem";
import { ARC_EIP155, GATEWAY_FACILITATOR, resolveArcRpc } from "@butler/arc";
import { decodeBatch } from "./circle-agent/decode-batch.ts";
import { fetchSettlement, resolveBatchTx } from "./circle-agent/trace.ts";
import {
  arcCanteenAvailable,
  arcCanteenRpcUrl,
  circleCliInstalled,
  circleCliLoggedIn,
  circleCliRunnable,
  circleGatewayBalance,
  circleListAgentWallets,
  circleLoginInit as circleCliLoginInit,
  circleLoginVerify as circleCliLoginVerify,
  circleLogout,
  circleVersion,
  circleWalletStatus,
  ensureCircleExecutor,
  getGatewayBalanceForApi,
  probeCircleCli,
  scheduleGatewayBalanceRefresh,
} from "./circle-cli.ts";
import { loadCircleConfig, resolveCircleExecutorAddress, resolveCircleChain, saveCircleConfig, useCircleCliPayments } from "./circle-config.ts";
import {
  appendRecord,
  createDefaultPolicy,
  evaluateSpend,
  loadState,
  remainingDailyUsdc,
  saveState,
  type SpendRecord,
} from "@butler/core";
import { runAgentTasks, agentRunReadiness } from "./agent-runner.ts";
import { registerMarketplaceRoutes } from "./marketplace-routes.ts";
import { enrichSpendPayer, getExecutorWalletAddress, resolveActivityPayerAddresses, attributeLedgerRecords, filterMineRecords, applyJobAttribution, spendInitiatorFromQuery } from "./ledger-payer.ts";
import { loadMarketplaceState } from "@butler/core";
import {
  buildResearchPayload,
  buildResearchSummary,
  buildSubscriptionAudit,
  buildUtilityQuote,
  fetchMarketQuote,
} from "./agent-services.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

type PaidRequest = express.Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

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

const app = express();
app.use(cors());
app.use(express.json());

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
  return async (req: PaidRequest, res: express.Response) => {
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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "live",
    chain: ARC_EIP155,
    seller: SELLER,
    rpc: resolveArcRpc().replace(/\/\/[^@]+@/, "//***@"),
  });
});

/** Public config for dashboard (RPC URL for MetaMask, etc.). */
app.get("/api/config", (_req, res) => {
  res.json({
    chain: ARC_EIP155,
    chainId: 5042002,
    seller: SELLER,
    arcRpc: resolveArcRpc(),
    gateway: process.env.GATEWAY_FACILITATOR_URL ?? GATEWAY_FACILITATOR,
    webUrl: WEB_URL,
  });
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

/** Circle CLI — email OTP login + agent wallet selection (no private key in .env). */
app.get("/api/circle/status", (_req, res) => {
  try {
    const cfg = loadCircleConfig();
    const probe = probeCircleCli();
    let executor = resolveCircleExecutorAddress();
    if (!executor && probe.loggedIn) {
      void Promise.resolve().then(() => ensureCircleExecutor());
    }
    const gatewayBalanceUsdc = getGatewayBalanceForApi(executor);
    res.json({
      installed: circleCliInstalled(),
      runnable: probe.runnable,
      loggedIn: probe.loggedIn,
      testnet: probe.testnet ?? true,
      version: circleVersion(),
      executorAddress: executor,
      email: cfg.email ?? probe.email,
      chain: cfg.chain ?? resolveCircleChain(),
      gatewayBalanceUsdc,
      session: probe.raw,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Circle status failed" });
  }
});

app.post("/api/circle/login/init", (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim();
    if (!email.includes("@")) {
      res.status(400).json({ error: "Valid email required" });
      return;
    }
    if (!circleCliRunnable()) {
      res.status(503).json({ error: "Circle CLI not installed. Run npm run circle:install on the server." });
      return;
    }
    const result = circleCliLoginInit(email, req.body?.testnet !== false);
    if (!result || !result.ok) {
      res.status(500).json({ error: result?.error ?? "Failed to send OTP" });
      return;
    }
    res.json({
      ok: true,
      requestId: result.requestId,
      email: result.email,
      message: result.message,
      otpPrefix: result.otpPrefix,
      hint: result.otpPrefix
        ? `Enter ${result.otpPrefix}-123456 or the 6 digits from your email (one verify attempt per code).`
        : "Check your email for a code like B1X-123456 (6 digits also works). One verify attempt per code.",
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to send OTP",
    });
  }
});

app.post("/api/circle/login/verify", (req, res) => {
  try {
    const requestId = String(req.body?.requestId ?? "").trim();
    const otp = String(req.body?.otp ?? "").trim();
    if (!requestId || !otp) {
      res.status(400).json({ error: "requestId and otp required" });
      return;
    }
    const emailHint = String(req.body?.email ?? "").trim();
    const result = circleCliLoginVerify(requestId, otp, req.body?.testnet !== false);
    if (!result || !result.ok) {
      res.status(401).json({ error: result?.error ?? "Login failed", needsNewCode: result?.needsNewCode ?? false });
      return;
    }
    const savedEmail = result.email ?? (emailHint.includes("@") ? emailHint : undefined);
    if (savedEmail) saveCircleConfig({ email: savedEmail });
    const chain = resolveCircleChain();
    const wallets = circleListAgentWallets(chain);
    const first = wallets[0]?.address as `0x${string}` | undefined;
    if (first && !resolveCircleExecutorAddress()) {
      saveCircleConfig({ executorAddress: first, chain });
    }
    ensureCircleExecutor();
    res.json({
      ok: true,
      email: savedEmail ?? result.email,
      message: result.message,
      wallets,
      executorAddress: ensureCircleExecutor() ?? resolveCircleExecutorAddress(),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Login verify failed",
      needsNewCode: true,
    });
  }
});

app.post("/api/circle/logout", (_req, res) => {
  try {
    const result = circleLogout();
    if (!result?.ok) {
      res.status(500).json({ error: result?.error ?? "Logout failed" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Logout failed" });
  }
});

app.get("/api/circle/wallets", (_req, res) => {
  if (!circleCliLoggedIn()) {
    res.status(401).json({ error: "Not logged in to Circle CLI" });
    return;
  }
  const chain = resolveCircleChain();
  res.json({
    chain,
    wallets: circleListAgentWallets(chain),
    executorAddress: ensureCircleExecutor() ?? resolveCircleExecutorAddress(),
  });
});

app.post("/api/circle/executor", (req, res) => {
  const address = String(req.body?.address ?? "").trim();
  if (!address.startsWith("0x")) {
    res.status(400).json({ error: "address required" });
    return;
  }
  const cfg = saveCircleConfig({
    executorAddress: address as `0x${string}`,
    chain: (req.body?.chain as string) ?? resolveCircleChain(),
  });
  res.json({ ok: true, executorAddress: cfg.executorAddress, chain: cfg.chain });
});

app.get("/api/circle/gateway/balance", (req, res) => {
  try {
    const address = String(req.query.address ?? resolveCircleExecutorAddress() ?? "");
    if (!address.startsWith("0x")) {
      res.status(400).json({ error: "address required" });
      return;
    }
    if (!circleCliLoggedIn()) {
      res.status(401).json({ error: "Circle login required" });
      return;
    }
    scheduleGatewayBalanceRefresh(address);
    const cached = getGatewayBalanceForApi(address);
    if (cached != null) {
      res.json({ data: { total: cached, token: "USDC", address, cached: true } });
      return;
    }
    const chain = String(req.query.chain ?? resolveCircleChain());
    const bal = circleGatewayBalance(address, chain);
    if (!bal?.ok) {
      res.status(500).json({ error: bal?.error ?? "Balance lookup failed" });
      return;
    }
    try {
      res.json(JSON.parse(bal.raw ?? "{}"));
    } catch {
      res.json({ raw: bal.raw });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Balance lookup failed" });
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
  const state = loadState(STATE_PATH);
  const mp = loadMarketplaceState(MARKETPLACE_PATH, SELLER);
  const scope = String(req.query.scope ?? "all");
  const attributed = applyJobAttribution(
    attributeLedgerRecords(state.records),
    mp.jobs,
    mp.auctions
  );
  const activityPayerAddresses = resolveActivityPayerAddresses(state.records);
  const allRecords = attributed.slice().reverse();

  if (scope === "mine") {
    const records = filterMineRecords(attributed, activityPayerAddresses).reverse();
    res.json({
      remainingDailyUsdc: remainingDailyUsdc(state.policy, state.records),
      records,
      totalCount: allRecords.length,
      activityPayerAddresses,
    });
    return;
  }

  res.json({
    remainingDailyUsdc: remainingDailyUsdc(state.policy, state.records),
    records: allRecords,
    totalCount: allRecords.length,
    activityPayerAddresses,
  });
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
    const executorAddress = getExecutorAddress();
    const readiness = agentRunReadiness();
    const circleExecutor = resolveCircleExecutorAddress();
    if (!circleExecutor && circleCliLoggedIn()) {
      void Promise.resolve().then(() => ensureCircleExecutor());
    }
    const gatewayBalanceUsdc = getGatewayBalanceForApi(circleExecutor);
    const activityPayerAddresses = resolveActivityPayerAddresses(state.records);
    res.json({
      executorAddress: executorAddress ?? circleExecutor,
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

app.listen(PORT, () => {
  const state = loadState(STATE_PATH);
  saveState(state, STATE_PATH);
  console.log(`Butler API http://localhost:${PORT}`);
  console.log(`  dashboard: ${WEB_URL}`);
  console.log(`  seller: ${SELLER}`);
  console.log(`  merchants: /merchants/research/*, /merchants/bills/*, /merchants/data/*`);
  console.log(`  marketplace: /api/marketplace · /marketplace/agents/*/execute (x402)`);
});
