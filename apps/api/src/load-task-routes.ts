/**
 * Task routes for lite API mode (agent status + butler run).
 * Loaded when BUTLER_LITE_API=true so Circle login works without full marketplace bundle.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";
import { sessionIdFromRequest } from "./user-session.ts";
import { filterJobsForOwner, jobVisibleToOwner, resolveJobOwnerFromRequest } from "./job-owner.ts";

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
    { loadState, remainingDailyUsdc },
    { getExecutorWalletAddress, resolveActivityPayerAddresses },
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
    const state = loadState(STATE_PATH, SELLER);
    res.json(state.policy);
  });

  app.get("/api/ledger", (req, res) => {
    const state = loadState(STATE_PATH, SELLER);
    const owner = resolveJobOwnerFromRequest(req);
    let records = state.records.slice().reverse();
    if (owner.payerAddress) {
      const addr = owner.payerAddress.toLowerCase();
      records = records.filter(
        (r) =>
          r.payerAddress?.toLowerCase() === addr ||
          r.executorAddress?.toLowerCase() === addr
      );
    } else if (owner.sessionId) {
      records = [];
    }
    const activityPayerAddresses = resolveActivityPayerAddresses(state.records);
    res.json({
      remainingDailyUsdc: remainingDailyUsdc(state.policy, state.records),
      records,
      totalCount: records.length,
      activityPayerAddresses,
    });
  });

  app.get("/api/agent/status", async (_req, res) => {
    try {
      const state = loadState(STATE_PATH, SELLER);
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
    "  task routes: policy · ledger · agent/status · butler/run · registry · x402 execute · deliverables (lite mode)"
  );

  setImmediate(() => {
    import("node:http").then((http) => {
      const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
      const req = http.get(
        `http://127.0.0.1:${port}/api/marketplace/agents/research-agent/execute`,
        { timeout: 4000 },
        (res) => {
          console.log(`  self-test research-agent execute: HTTP ${res.statusCode}`);
          res.resume();
        }
      );
      req.on("timeout", () => {
        req.destroy();
        console.error("  self-test research-agent execute: timeout (check routes)");
      });
      req.on("error", (e) => console.error("  self-test research-agent execute:", e.message));
    });
  });
}
