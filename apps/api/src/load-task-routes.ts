/**
 * Task routes for lite API mode (agent status + butler run).
 * Loaded when BUTLER_LITE_API=true so Circle login works without full marketplace bundle.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "../../../.data/butler-state.json");
const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const SELLER = (process.env.BUTLER_SELLER_ADDRESS ?? "0x933a2405f84c224be1ef373ba16e992e1f459682") as `0x${string}`;

function resolveApiBase(): string {
  const configured = process.env.BUTLER_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return `http://127.0.0.1:${PORT}`;
}

/** Circle CLI pays from this host — use loopback so x402 execute paths are not proxied via Vercel. */
function resolvePaymentApiBase(): string {
  const internal = process.env.BUTLER_INTERNAL_API_URL?.trim();
  if (internal) return internal.replace(/\/$/, "");
  return `http://127.0.0.1:${PORT}`;
}

export async function loadTaskRoutes(app: Express): Promise<void> {
  const [
    { agentRunReadiness },
    { runButler },
    { loadState, remainingDailyUsdc },
    { getExecutorWalletAddress, resolveActivityPayerAddresses },
    circleCli,
    circleConfig,
  ] = await Promise.all([
    import("./agent-runner.ts"),
    import("./butler.ts"),
    import("@butler/core"),
    import("./ledger-payer.ts"),
    import("./circle-cli.ts"),
    import("./circle-config.ts"),
  ]);

  app.get("/api/policy", (_req, res) => {
    const state = loadState(STATE_PATH);
    res.json(state.policy);
  });

  app.get("/api/ledger", (req, res) => {
    const state = loadState(STATE_PATH);
    const scope = String(req.query.scope ?? "all");
    const records = state.records.slice().reverse();
    const activityPayerAddresses = resolveActivityPayerAddresses(state.records);
    res.json({
      remainingDailyUsdc: remainingDailyUsdc(state.policy, state.records),
      records: scope === "mine" ? records : records,
      totalCount: records.length,
      activityPayerAddresses,
    });
  });

  app.get("/api/agent/status", async (_req, res) => {
    try {
      const state = loadState(STATE_PATH);
      const executorAddress = getExecutorWalletAddress();
      const readiness = agentRunReadiness();
      const circleExecutor = circleConfig.resolveCircleExecutorAddress();
      if (!circleExecutor && circleCli.circleCliLoggedIn()) {
        void Promise.resolve().then(() => circleCli.ensureCircleExecutor());
      }
      const gatewayBalanceUsdc = circleCli.getGatewayBalanceForApi(circleExecutor);
      const activityPayerAddresses = resolveActivityPayerAddresses(state.records);
      res.json({
        executorAddress: executorAddress ?? circleExecutor,
        executorReady: readiness.canRun,
        sellerAddress: SELLER,
        circleCli: circleCli.circleCliInstalled(),
        circleCliLoggedIn: circleCli.circleCliLoggedIn(),
        circleExecutorAddress: circleExecutor,
        activityPayerAddresses,
        useCircleCli: circleConfig.useCircleCliPayments() || circleCli.circleCliLoggedIn(),
        canRun: readiness.canRun,
        paymentMode: readiness.mode,
        gatewayBalanceUsdc,
        ...(readiness.reason ? { reason: readiness.reason } : {}),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Agent status failed" });
    }
  });

  const butlerReadiness = (_req: Request, res: Response) => {
    res.json(agentRunReadiness());
  };

  const butlerRun = async (req: Request, res: Response) => {
    const brief = String(req.body?.brief ?? "").trim();
    if (!brief) {
      res.status(400).json({ error: "brief required" });
      return;
    }
    if (!!req.body?.dryRun) {
      res.status(400).json({ error: "dryRun is disabled — Butler executes real x402 payments" });
      return;
    }
    try {
      const result = await runButler({
        brief,
        apiBase: resolvePaymentApiBase(),
        statePath: STATE_PATH,
        sellerAddress: SELLER,
        strategy: req.body?.strategy === "direct" ? "direct" : "auction",
        category: req.body?.category,
        minReputation: req.body?.minReputation != null ? Number(req.body.minReputation) : undefined,
        ttlSeconds: req.body?.ttlSeconds != null ? Number(req.body.ttlSeconds) : undefined,
        qualityTier: req.body?.qualityTier,
        maxBudgetUsdc: req.body?.maxBudgetUsdc != null ? String(req.body.maxBudgetUsdc) : undefined,
        auctionMode:
          req.body?.auctionMode === "etf" ? "etf" : req.body?.auctionMode === "single" ? "single" : undefined,
        forceX402: !!req.body?.forceX402,
      });
      if (!result?.ok) {
        const unavailable =
          result?.error?.includes("Payer not configured") || result?.error?.includes("Circle");
        res.status(unavailable ? 503 : 200).json(result ?? { ok: false, error: "Butler returned no result" });
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Butler failed" });
    }
  };

  app.get("/api/butler/readiness", butlerReadiness);
  app.post("/api/butler/run", butlerRun);
  app.get("/api/payer-agent/readiness", butlerReadiness);
  app.post("/api/payer-agent/run", butlerRun);

  const [
    { registerRegistryRoutes },
    { createMarketplaceGateway, registerAgentExecuteRoutes },
    { buildJobSummary, inferPlanFromJob },
    { loadMarketplaceState },
  ] = await Promise.all([
    import("./registry-routes.ts"),
    import("./marketplace-execute.ts"),
    import("./marketplace-task.ts"),
    import("@butler/core"),
  ]);

  const apiBase = resolveApiBase();
  registerRegistryRoutes(app, { apiBase, statePath: STATE_PATH, sellerAddress: SELLER });

  const gateway = await createMarketplaceGateway(SELLER);
  registerAgentExecuteRoutes(app, gateway, {
    statePath: STATE_PATH,
    policyStatePath: STATE_PATH,
    sellerAddress: SELLER,
  });

  function loadMp() {
    return loadMarketplaceState(STATE_PATH, SELLER);
  }

  app.get("/api/marketplace/jobs", (_req, res) => {
    res.json(loadMp().jobs.slice(-50).reverse());
  });

  app.get("/api/marketplace/jobs/:id", (req, res) => {
    const job = loadMp().jobs.find((j) => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ ...job, plan: job.plan ?? inferPlanFromJob(job), summary: buildJobSummary(job) });
  });

  app.get("/api/marketplace/deliverables", (_req, res) => {
    const jobs = loadMp()
      .jobs.filter((j) => j.status === "completed")
      .slice(-50)
      .reverse()
      .map((j) => ({
        ...j,
        plan: j.plan ?? inferPlanFromJob(j),
        summary: buildJobSummary(j),
      }));
    res.json(jobs);
  });

  console.log(
    "  task routes: policy · ledger · agent/status · butler/run · registry · x402 execute · deliverables (lite mode)"
  );
}
