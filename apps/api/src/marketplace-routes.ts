import type { Express, Request, Response } from "express";
import { dirname, resolve } from "node:path";
import type { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import {
  getAgentCredits,
  getMarketplaceAgent,
  getMarketplaceEtf,
  initAgentApprovals,
  initializeAuction,
  listMarketplaceAgents,
  loadMarketplaceState,
  defaultAuctionMode,
  resolveTaskCategory,
  MARKETPLACE_ETFS,
  mergeAuctionBids,
  mergeAuctionUpdates,
  mergeJobUpdates,
  buildCatalogBid,
  recordAgentFailure,
  recordAgentSuccess,
  saveMarketplaceState,
  treasuryCredit,
  validateCustomBid,
  type MarketplaceJob,
  type QualityTier,
  type AuctionMode,
  type ReverseAuction,
} from "@butler/core";
import {
  buildDirectJob,
  buildEtfJob,
  runMarketplaceWorkflow,
} from "./marketplace-orchestrator.ts";
import { buildJobSummary, finalizeCompletedJob, inferPlanFromJob, planToJobPlan, runMarketplaceTask } from "./marketplace-task.ts";
import { getOpenAiPlannerStatus } from "./openai-planner.ts";
import {
  executeAuctionAward,
  loadProcessedAuctions,
  startAuctionEngine,
} from "./auction-engine.ts";
import { registerRegistryRoutes } from "./registry-routes.ts";
import { registerAgentExecuteRoutes } from "./marketplace-execute.ts";
import { agentRunReadiness } from "./agent-runner.ts";
import { runButler } from "./butler.ts";
import {
  getExternalAgentPolicy,
  loadExternalAgentRegistry,
  getRegistryPath,
} from "./external-agent-registry.ts";

type Gateway = ReturnType<typeof createGatewayMiddleware>;

export function registerMarketplaceRoutes(
  app: Express,
  opts: {
    gateway: Gateway;
    apiBase: string;
    statePath: string;
    policyStatePath: string;
    sellerAddress: string;
  }
): () => void {
  const { gateway, apiBase, statePath, policyStatePath, sellerAddress } = opts;

  const registryPath = getRegistryPath();
  const approvalsPath =
    process.env.BUTLER_AGENT_APPROVALS_PATH?.trim() ||
    resolve(dirname(statePath), "agent-approvals.json");
  initAgentApprovals(approvalsPath);
  loadExternalAgentRegistry({ registryPath });

  registerRegistryRoutes(app, { apiBase, statePath, sellerAddress });
  registerAgentExecuteRoutes(app, gateway, { statePath, policyStatePath, sellerAddress });

  function loadMp() {
    return loadMarketplaceState(statePath, sellerAddress);
  }

  function mpCredits() {
    return getAgentCredits(loadMp(), getExternalAgentPolicy().baselineReputation);
  }

  function saveMp(state: ReturnType<typeof loadMp>) {
    const latest = loadMp();
    const next = {
      ...latest,
      agentStats: { ...latest.agentStats, ...state.agentStats },
      treasury: { ...latest.treasury, ...state.treasury },
      jobs: mergeJobUpdates(latest.jobs, state.jobs),
      auctions: mergeAuctionUpdates(latest.auctions, state.auctions),
    };
    saveMarketplaceState(next, statePath);
    return next;
  }

  // --- Control plane (registry) + treasury ---
  app.get("/api/marketplace/treasury", (_req, res) => {
    res.json(loadMp().treasury);
  });

  app.post("/api/marketplace/treasury/deposit", (_req, res) => {
    res.status(501).json({
      error: "Treasury is funded by real x402 payments. Deposit USDC to the seller wallet and run agent workflows.",
    });
  });

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
      .map((j) => {
        try {
          return {
            ...j,
            plan: j.plan ?? inferPlanFromJob(j),
            summary: buildJobSummary(j),
          };
        } catch (err) {
          return {
            ...j,
            plan: j.plan ?? inferPlanFromJob(j),
            summary: j.summary ?? (err instanceof Error ? err.message : "Summary unavailable"),
          };
        }
      });
    res.json(jobs);
  });

  app.post("/api/marketplace/jobs", (req, res) => {
    const { agentId, etfId, brief } = req.body ?? {};
    let job: MarketplaceJob | null = null;
    if (etfId) job = buildEtfJob(String(etfId), brief ? String(brief) : undefined);
    else if (agentId) job = buildDirectJob(String(agentId), brief ? String(brief) : undefined);
    if (!job) {
      res.status(400).json({ error: "agentId or etfId required" });
      return;
    }
    let mp = loadMp();
    mp = { ...mp, jobs: [...mp.jobs, job] };
    saveMp(mp);
    res.status(201).json(job);
  });

  app.post("/api/marketplace/jobs/:id/run", async (req, res) => {
    const mp = loadMp();
    const job = mp.jobs.find((j) => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const dryRun = !!req.body?.dryRun;
    const forceX402 = !!req.body?.forceX402;
    if (dryRun) {
      res.status(400).json({ error: "dryRun is disabled — workflows execute real x402 payments" });
      return;
    }
    try {
      const result = await runMarketplaceWorkflow({ apiBase, job, forceX402, initiator: "user" });
      let next = loadMp();
      const updated = finalizeCompletedJob(job, result);
      next = {
        ...next,
        jobs: next.jobs.map((j) => (j.id === job.id ? updated : j)),
      };
      for (const step of result.steps ?? []) {
        const agent = getMarketplaceAgent(step.agentId);
        if (!agent) continue;
        next = step?.ok
          ? recordAgentSuccess(next, step.agentId, agent.priceUsdc, agent.etaSeconds)
          : recordAgentFailure(next, step.agentId);
        if (step?.ok) next = treasuryCredit(next, agent.priceUsdc);
      }
      saveMp(next);
      res.json({ job: updated, orchestration: result });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Workflow failed" });
    }
  });

  app.post("/api/marketplace/workflows/run", async (req, res) => {
    const etfId = req.body?.etfId ? String(req.body.etfId) : "";
    const brief = req.body?.brief ? String(req.body.brief).trim() : "";
    if (!etfId) {
      res.status(400).json({ error: "etfId required" });
      return;
    }
    if (!brief) {
      res.status(400).json({ error: "brief required" });
      return;
    }
    const job = buildEtfJob(etfId, brief);
    if (!job) {
      res.status(400).json({ error: "Unknown ETF" });
      return;
    }
    let mp = loadMp();
    mp = { ...mp, jobs: [...mp.jobs, job] };
    saveMp(mp);

    const forceX402 = !!req.body?.forceX402;
    if (!!req.body?.dryRun) {
      res.status(400).json({ error: "dryRun is disabled — workflows execute real x402 payments" });
      return;
    }
    try {
      const result = await runMarketplaceWorkflow({
        apiBase,
        job,
        forceX402: !!req.body?.forceX402,
        initiator: "user",
      });
      mp = loadMp();
      const updated = finalizeCompletedJob(
        { ...job, plan: { strategy: "etf", agentIds: job.steps.map((s) => s.agentId), etfId: job.etfId } },
        result
      );
      mp = { ...mp, jobs: [...mp.jobs.filter((j) => j.id !== job.id), updated] };
      for (const step of result.steps ?? []) {
        const agent = getMarketplaceAgent(step.agentId);
        if (!agent || !step?.ok) continue;
        mp = recordAgentSuccess(mp, step.agentId, agent.priceUsdc, agent.etaSeconds);
        mp = treasuryCredit(mp, agent.priceUsdc);
      }
      saveMp(mp);
      res.json({ job: updated, orchestration: result, etf: getMarketplaceEtf(etfId), summary: updated.summary });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Workflow failed" });
    }
  });

  app.get("/api/agent/planner", (_req, res) => {
    res.json(getOpenAiPlannerStatus());
  });

  app.post("/api/marketplace/tasks/run", async (req, res) => {
    const task = String(req.body?.task ?? "").trim();
    if (!task) {
      res.status(400).json({ error: "task required" });
      return;
    }
    const mode = req.body?.mode === "manual" ? "manual" : "auto";
    const agentIds = Array.isArray(req.body?.agentIds)
      ? req.body.agentIds.map((id: unknown) => String(id))
      : undefined;
    const etfId = req.body?.etfId ? String(req.body.etfId) : null;
    if (!!req.body?.dryRun) {
      res.status(400).json({ error: "dryRun is disabled — tasks execute real x402 payments" });
      return;
    }
    try {
      const result = await runMarketplaceTask({
        apiBase,
        task,
        mode,
        agentIds,
        etfId,
        forceX402: !!req.body?.forceX402,
        credits: mpCredits(),
      });
      let mp = loadMp();
      const updated = result.job;
      mp = { ...mp, jobs: [...mp.jobs.filter((j) => j.id !== updated.id), updated] };
      for (const step of result.orchestration?.steps ?? []) {
        if (!step?.ok) continue;
        const agent = getMarketplaceAgent(step.agentId);
        if (!agent) continue;
        mp = recordAgentSuccess(mp, step.agentId, agent.priceUsdc, agent.etaSeconds);
        mp = treasuryCredit(mp, agent.priceUsdc);
      }
      saveMp(mp);
      res.json({
        plan: result.plan,
        job: updated,
        orchestration: result.orchestration,
        summary: result.summary,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Task failed" });
    }
  });

  // --- Reverse auctions (automated competitive bidding) ---
  function syncAuctions() {
    const { auctions, toAward } = loadProcessedAuctions(statePath, sellerAddress);
    for (const id of toAward) {
      void executeAuctionAward({ statePath, sellerAddress, apiBase, auctionId: id });
    }
    return auctions;
  }

  app.get("/api/marketplace/auctions", (_req, res) => {
    res.json(syncAuctions());
  });

  app.get("/api/marketplace/auctions/:id", (req, res) => {
    const auction = syncAuctions().find((a) => a.id === req.params.id);
    if (!auction) {
      res.status(404).json({ error: "Auction not found" });
      return;
    }
    res.json(auction);
  });

  app.post("/api/marketplace/auctions", (req, res) => {
    const brief = String(req.body?.brief ?? "").trim();
    if (!brief) {
      res.status(400).json({ error: "brief required" });
      return;
    }
    let mp = loadMp();
    const qualityTier = (req.body?.qualityTier ?? "standard") as QualityTier;
    const maxBudgetUsdc = req.body?.maxBudgetUsdc != null ? String(req.body.maxBudgetUsdc).trim() : undefined;
    const auctionMode = defaultAuctionMode(
      qualityTier,
      req.body?.auctionMode === "etf" ? "etf" : req.body?.auctionMode === "single" ? "single" : undefined
    );
    const userCategory = req.body?.category as ReverseAuction["category"] | undefined;
    const auction = initializeAuction({
      brief,
      category: resolveTaskCategory(brief, userCategory, qualityTier),
      minReputation: Number(req.body?.minReputation ?? 70),
      ttlSeconds: Number(req.body?.ttlSeconds ?? 90),
      autoAward: req.body?.autoAward !== false,
      bidIntervalSeconds: Number(req.body?.bidIntervalSeconds ?? 12),
      qualityTier,
      maxBudgetUsdc: maxBudgetUsdc || undefined,
      auctionMode,
      credits: mpCredits(),
    });
    mp = { ...mp, auctions: [...mp.auctions, auction] };
    saveMp(mp);
    res.status(201).json(auction);
  });

  app.post("/api/marketplace/auctions/:id/solicit", (req, res) => {
    const auction = syncAuctions().find((a) => a.id === req.params.id);
    if (!auction) {
      res.status(404).json({ error: "Auction not found" });
      return;
    }
    res.json(auction);
  });

  app.post("/api/marketplace/auctions/:id/bids", (req, res) => {
    const agentId = String(req.body?.agentId ?? "").trim();
    const priceUsdc = String(req.body?.priceUsdc ?? "").trim();
    if (!agentId) {
      res.status(400).json({ error: "agentId required" });
      return;
    }

    let mp = loadMp();
    const auction = mp.auctions.find((a) => a.id === req.params.id);
    if (!auction) {
      res.status(404).json({ error: "Auction not found" });
      return;
    }
    if (auction.status !== "open") {
      res.status(400).json({ error: "Auction is not open" });
      return;
    }
    if (Math.floor(Date.now() / 1000) > auction.deadlineAt) {
      res.status(400).json({ error: "Auction deadline passed" });
      return;
    }

    const agent = getMarketplaceAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const credits = new Map(mpCredits().map((c) => [c.agentId, c]));
    const score = credits.get(agentId)?.score ?? 0;
    if (score < auction.minReputation) {
      res.status(403).json({ error: `Agent reputation ${score} below minimum ${auction.minReputation}` });
      return;
    }

    const bidPrice = priceUsdc || agent.priceUsdc;
    const check = validateCustomBid(agentId, bidPrice);
    if (!check?.ok) {
      res.status(400).json({ error: check?.error ?? "Invalid bid" });
      return;
    }
    if (auction.maxBudgetUsdc && Number(bidPrice) > Number(auction.maxBudgetUsdc) + 1e-9) {
      res.status(400).json({ error: `Bid exceeds max budget ($${auction.maxBudgetUsdc})` });
      return;
    }

    const base = buildCatalogBid(agentId, credits);
    if (!base) {
      res.status(500).json({ error: "Could not build bid" });
      return;
    }

    const bid = { ...base, priceUsdc: bidPrice, at: Math.floor(Date.now() / 1000) };

    const updated = {
      ...auction,
      bids: mergeAuctionBids(auction.bids, [bid]),
    };
    mp = { ...mp, auctions: mp.auctions.map((a) => (a.id === auction.id ? updated : a)) };
    saveMp(mp);
    res.status(201).json(updated);
  });

  app.post("/api/marketplace/auctions/:id/award", async (req, res) => {
    try {
      const result = await executeAuctionAward({
        statePath,
        sellerAddress,
        apiBase,
        auctionId: req.params.id,
        forceX402: !!req.body?.forceX402,
      });
      if (!result?.ok) {
        res.status(400).json({ error: result?.error ?? "Award failed" });
        return;
      }
      const auction = syncAuctions().find((a) => a.id === req.params.id);
      res.json({ ok: true, auction });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Award failed" });
    }
  });

  // --- Butler orchestrator (discover → negotiate → settle) ---
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
        apiBase,
        statePath,
        sellerAddress,
        strategy: req.body?.strategy === "direct" ? "direct" : "auction",
        category: req.body?.category,
        minReputation: req.body?.minReputation != null ? Number(req.body.minReputation) : undefined,
        ttlSeconds: req.body?.ttlSeconds != null ? Number(req.body.ttlSeconds) : undefined,
        qualityTier: req.body?.qualityTier,
        maxBudgetUsdc: req.body?.maxBudgetUsdc != null ? String(req.body.maxBudgetUsdc) : undefined,
        auctionMode: req.body?.auctionMode === "etf" ? "etf" : req.body?.auctionMode === "single" ? "single" : undefined,
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

  return startAuctionEngine({ statePath, sellerAddress, apiBase });
}
