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

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolveButlerStatePath();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AgentDeps = {
  agentRunReadiness: () => { canRun: boolean; reason?: string; mode?: string };
  loadState: typeof import("@butler/core").loadState;
  getExecutorWalletAddress: () => string | null;
  resolveSessionActivityPayerAddresses: (records: import("@butler/core").SpendRecord[]) => string[];
  circleCli: typeof import("./circle-cli.ts");
  circleConfig: typeof import("./circle-config.ts");
  getOpenAiPlannerStatus: () => import("./openai-planner.ts").OpenAiPlannerStatus;
};

let agentDepsPromise: Promise<AgentDeps> | null = null;

function loadAgentDeps(): Promise<AgentDeps> {
  agentDepsPromise ??= Promise.all([
    import("./agent-runner.ts"),
    import("@butler/core"),
    import("./ledger-payer.ts"),
    import("./circle-cli.ts"),
    import("./circle-config.ts"),
    import("./openai-planner.ts"),
  ]).then(([agentRunner, core, ledgerPayer, circleCli, circleConfig, openai]) => ({
    agentRunReadiness: agentRunner.agentRunReadiness,
    loadState: core.loadState,
    getExecutorWalletAddress: ledgerPayer.getExecutorWalletAddress,
    resolveSessionActivityPayerAddresses: ledgerPayer.resolveSessionActivityPayerAddresses,
    circleCli,
    circleConfig,
    getOpenAiPlannerStatus: openai.getOpenAiPlannerStatus,
  }));
  return agentDepsPromise;
}

async function registerMarketplaceExecuteRoutes(
  app: Express,
  importPromise: Promise<typeof import("./marketplace-execute.ts")>
): Promise<void> {
  const opts = {
    statePath: STATE_PATH,
    policyStatePath: STATE_PATH,
    sellerAddress: SELLER,
  };
  const { setExecuteLoadError, setBootPhase } = await import("./route-loader-status.ts");
  setBootPhase("execute-import");

  try {
    const mod = await Promise.race([
      importPromise,
      sleep(60_000).then(() => {
        throw new Error("marketplace-execute import timed out after 60s");
      }),
    ]);

    setBootPhase("execute-gateway");
    let gateway: Awaited<ReturnType<typeof mod.createMarketplaceGateway>> | null = null;
    try {
      gateway = await Promise.race([
        mod.createMarketplaceGateway(SELLER),
        sleep(30_000).then(() => {
          throw new Error("Circle Gateway init timed out after 30s");
        }),
      ]);
      await Promise.race([mod.warmGatewayFacilitator(gateway), sleep(15_000)]);
    } catch (gwErr) {
      const msg = gwErr instanceof Error ? gwErr.message : String(gwErr);
      console.warn("Gateway setup skipped — lite execute routes:", msg);
      gateway = null;
    }

    mod.registerAgentExecuteRoutes(app, gateway, opts);
    mod.prefetchAgentServices();
    setBootPhase("live");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execute routes failed to load";
    setExecuteLoadError(message);
    console.error("Butler API execute routes failed:", message);
    try {
      const mod = await Promise.race([importPromise, sleep(60_000)]);
      mod.registerAgentExecuteRoutes(app, null, opts);
      mod.prefetchAgentServices();
      setBootPhase("live-lite");
      console.log("  x402 execute routes: fallback lite mode (no Gateway middleware)");
    } catch (fallbackErr) {
      setBootPhase("execute-failed");
      console.error(
        "Execute routes fallback failed:",
        fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
      );
    }
  }
}

export async function loadTaskRoutes(app: Express): Promise<void> {
  const { setBootPhase } = await import("./route-loader-status.ts");
  setBootPhase("start");
  console.log("  task routes: boot start");

  /** Prefetch while lighter routes register — import is heavy on small VMs. */
  const marketplaceExecuteImport = import("./marketplace-execute.ts");
  void loadAgentDeps().catch((err) => {
    console.error("Agent deps prefetch failed:", err instanceof Error ? err.message : err);
  });

  setBootPhase("core");
  const { loadState, loadMarketplaceState } = await import("@butler/core");
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

  setBootPhase("trace");
  void import("./trace-routes.ts")
    .then(({ registerTraceRoutes }) => registerTraceRoutes(app))
    .catch((err) => {
      console.error("Trace routes failed to load:", err instanceof Error ? err.message : err);
    });

  app.get("/api/agent/status", async (_req, res) => {
    try {
      const deps = await loadAgentDeps();
      const state = deps.loadState(STATE_PATH, SELLER);
      const circleExecutor = deps.circleConfig.resolveCircleExecutorAddress();
      const executorAddress =
        circleExecutor ?? (hasActiveUserSession() ? null : deps.getExecutorWalletAddress());
      const readiness = deps.agentRunReadiness();
      if (!circleExecutor && deps.circleCli.circleCliLoggedIn()) {
        void Promise.resolve().then(() => deps.circleCli.ensureCircleExecutor());
      }
      const gatewayBalanceUsdc = deps.circleCli.getGatewayBalanceForApi(circleExecutor);
      const activityPayerAddresses = deps.resolveSessionActivityPayerAddresses(state.records);
      res.json({
        executorAddress,
        executorReady: readiness.canRun,
        sellerAddress: SELLER,
        circleCli: deps.circleCli.circleCliInstalled(),
        circleCliLoggedIn: deps.circleCli.circleCliLoggedIn(),
        circleExecutorAddress: circleExecutor,
        activityPayerAddresses,
        useCircleCli: deps.circleConfig.useCircleCliPayments() || deps.circleCli.circleCliLoggedIn(),
        canRun: readiness.canRun,
        paymentMode: readiness.mode,
        gatewayBalanceUsdc,
        openAiPlanner: deps.getOpenAiPlannerStatus(),
        ...(readiness.reason ? { reason: readiness.reason } : {}),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Agent status failed" });
    }
  });

  const butlerReadiness = async (_req: Request, res: Response) => {
    const { agentRunReadiness } = await import("./agent-runner.ts");
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

  setBootPhase("auctions");
  const apiBase = resolveApiBase();
  const { registerAuctionRoutes } = await import("./auction-routes.ts");
  registerAuctionRoutes({
    app,
    statePath: STATE_PATH,
    sellerAddress: SELLER,
    apiBase,
  });
  console.log("  task routes: auctions registered");

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

  app.get("/api/marketplace/jobs/:id", async (req, res) => {
    const owner = resolveJobOwnerFromRequest(req);
    const job = loadMp().jobs.find((j) => j.id === req.params.id);
    if (!job || !jobVisibleToOwner(job, owner)) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const { buildJobSummary, inferPlanFromJob } = await import("./marketplace-task.ts");
    res.json({ ...job, plan: job.plan ?? inferPlanFromJob(job), summary: buildJobSummary(job) });
  });

  app.get("/api/marketplace/deliverables", async (req, res) => {
    const owner = resolveJobOwnerFromRequest(req);
    const { buildJobSummary, inferPlanFromJob } = await import("./marketplace-task.ts");
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

  setBootPhase("shell-done");
  console.log(
    "  task routes: policy · trace · agent/status · butler/run · auctions · deliverables (lite mode)"
  );

  void registerMarketplaceExecuteRoutes(app, marketplaceExecuteImport);
}
