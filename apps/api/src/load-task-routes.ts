/**
 * Task routes for lite API mode (agent status + butler run).
 * Loaded when BUTLER_LITE_API=true so Circle login works without full marketplace bundle.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";
import { sessionIdFromRequest, hasActiveUserSession } from "./user-session.ts";
import { filterJobsForOwner, jobVisibleToOwner, resolveJobOwnerFromRequest } from "./job-owner.ts";
import { resolveButlerStatePath, resolveMarketplaceStatePath } from "./data-paths.ts";
import { handleGetPolicy, handlePutPolicy, handleResetPolicy } from "./policy-handlers.ts";
import { handleGetUserPreferences, handlePutUserPreferences } from "./user-preferences.ts";
import { registerAuctionRoutes } from "./auction-routes.ts";
import { registerTraceRoutes } from "./trace-routes.ts";
import { getOpenAiPlannerStatus } from "./openai-planner.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolveButlerStatePath();
const MARKETPLACE_PATH = resolveMarketplaceStatePath();
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
    { loadState, remainingDailyUsdc },
    { getExecutorWalletAddress, resolveSessionActivityPayerAddresses },
    circleCli,
    circleConfig,
  ] = await Promise.all([
    import("./agent-runner.ts"),
    import("@butler/core"),
    import("./ledger-payer.ts"),
    import("./circle-cli.ts"),
    import("./circle-config.ts"),
  ]);

  loadState(STATE_PATH, SELLER);

  app.get("/api/policy", (_req, res) => {
    handleGetPolicy(res, STATE_PATH, SELLER);
  });

  app.put("/api/policy", (req, res) => {
    handlePutPolicy(req, res, STATE_PATH, SELLER);
  });

  app.post("/api/policy/reset", (req, res) => {
    handleResetPolicy(req, res, STATE_PATH, SELLER);
  });

  app.get("/api/user/preferences", (req, res) => {
    handleGetUserPreferences(req, res);
  });

  app.put("/api/user/preferences", (req, res) => {
    handlePutUserPreferences(req, res);
  });

  await registerTraceRoutes(app);

  app.get("/api/agent/status", async (_req, res) => {
    try {
      const state = loadState(STATE_PATH, SELLER);
      const circleExecutor = circleConfig.resolveCircleExecutorAddress();
      const executorAddress =
        circleExecutor ?? (hasActiveUserSession() ? null : getExecutorWalletAddress());
      const readiness = agentRunReadiness();
      if (!circleExecutor && circleCli.circleCliLoggedIn()) {
        void Promise.resolve().then(() => circleCli.ensureCircleExecutor());
      }
      const gatewayBalanceUsdc = circleCli.getGatewayBalanceForApi(circleExecutor);
      const activityPayerAddresses = resolveSessionActivityPayerAddresses(state.records);
      res.json({
        executorAddress,
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
        openAiPlanner: getOpenAiPlannerStatus(),
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
    const sessionId = sessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).json({
        error: "Missing browser session — refresh the dashboard. Each user needs an isolated session to pay and view tasks.",
      });
      return;
    }
    if (!!req.body?.dryRun) {
      res.status(400).json({ error: "dryRun is disabled — Butler executes real x402 payments" });
      return;
    }
    const params = {
      brief,
      apiBase: resolvePaymentApiBase(),
      statePath: STATE_PATH,
      sellerAddress: SELLER,
      strategy: req.body?.strategy === "direct" ? ("direct" as const) : ("auction" as const),
      category: req.body?.category,
      minReputation: req.body?.minReputation != null ? Number(req.body.minReputation) : undefined,
      ttlSeconds: req.body?.ttlSeconds != null ? Number(req.body.ttlSeconds) : undefined,
      qualityTier: req.body?.qualityTier,
      maxBudgetUsdc: req.body?.maxBudgetUsdc != null ? String(req.body.maxBudgetUsdc) : undefined,
      auctionMode:
        req.body?.auctionMode === "etf" ? ("etf" as const) : req.body?.auctionMode === "single" ? ("single" as const) : undefined,
      forceX402: !!req.body?.forceX402,
      sessionId: sessionId ?? undefined,
    };
    const { startButlerRunJob } = await import("./butler-run-jobs.ts");
    const runId = startButlerRunJob(params);
    res.status(202).json({ pending: true, runId, brief });
  };

  const butlerRunPoll = async (req: Request, res: Response) => {
    const { getButlerRunJob } = await import("./butler-run-jobs.ts");
    const job = getButlerRunJob(req.params.runId);
    if (!job) {
      res.status(404).json({ error: "Butler run not found or expired — submit the task again." });
      return;
    }
    res.json({
      status: job.status,
      result: job.result,
      error: job.error,
      elapsedMs: Date.now() - job.startedAt,
    });
  };

  app.get("/api/butler/readiness", butlerReadiness);
  app.post("/api/butler/run", butlerRun);
  app.get("/api/butler/run/:runId", butlerRunPoll);
  app.get("/api/payer-agent/readiness", butlerReadiness);
  app.post("/api/payer-agent/run", butlerRun);
  app.get("/api/payer-agent/run/:runId", butlerRunPoll);

  const [
    { registerRegistryRoutes },
    { buildJobSummary, inferPlanFromJob },
    { loadMarketplaceState },
  ] = await Promise.all([
    import("./registry-routes.ts"),
    import("./marketplace-task.ts"),
    import("@butler/core"),
  ]);

  const apiBase = resolveApiBase();

  registerAuctionRoutes({
    app,
    statePath: STATE_PATH,
    sellerAddress: SELLER,
    apiBase,
  });

  try {
    const { createMarketplaceGateway, registerAgentExecuteRoutes, warmGatewayFacilitator } = await import(
      "./marketplace-execute.ts"
    );
    const gateway = await createMarketplaceGateway(SELLER);
    await warmGatewayFacilitator(gateway);
    // Register execute routes before registry so /agents/:agentId/execute is not shadowed.
    registerAgentExecuteRoutes(app, gateway, {
      statePath: STATE_PATH,
      policyStatePath: STATE_PATH,
      sellerAddress: SELLER,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execute routes failed to load";
    const { setExecuteLoadError } = await import("./route-loader-status.ts");
    setExecuteLoadError(message);
    console.error("Butler API execute routes failed:", message);
  }

  registerRegistryRoutes(app, { apiBase, statePath: STATE_PATH, sellerAddress: SELLER });

  const { getRouteLoaderStatus } = await import("./route-loader-status.ts");
  app.get("/api/marketplace/loader-status", (_req, res) => {
    res.json(getRouteLoaderStatus());
  });

  function loadMp() {
    return loadMarketplaceState(STATE_PATH, SELLER);
  }

  app.get("/api/marketplace/jobs", (_req, res) => {
    res.json(loadMp().jobs.slice(-50).reverse());
  });

  app.get("/api/marketplace/jobs/:id", (req, res) => {
    const owner = resolveJobOwnerFromRequest(req);
    const job = loadMp().jobs.find((j) => j.id === req.params.id);
    if (!job || !jobVisibleToOwner(job, owner)) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ ...job, plan: job.plan ?? inferPlanFromJob(job), summary: buildJobSummary(job) });
  });

  app.get("/api/marketplace/deliverables", (req, res) => {
    const owner = resolveJobOwnerFromRequest(req);
    const jobs = filterJobsForOwner(
      loadMp().jobs.filter((j) => j.status === "completed"),
      owner
    )
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
    "  task routes: policy · ledger · trace · agent/status · butler/run · auctions · registry · x402 execute · deliverables (lite mode)"
  );
}
