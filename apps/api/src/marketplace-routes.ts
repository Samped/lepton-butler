import type { Express, Response } from "express";
import { dirname, resolve } from "node:path";
import { formatUnits } from "viem";
import type { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import {
  appendRecord,
  buildQuoteForAgent,
  evaluateSpend,
  getAgentCredits,
  getMarketplaceAgent,
  getMarketplaceEtf,
  getApprovedAgentIds,
  initAgentApprovals,
  initializeAuction,
  isAgentApproved,
  listMarketplaceAgents,
  requireAgentApproval,
  etfAgentsApproved,
  setAgentApproved,
  loadMarketplaceState,
  loadState,
  defaultAuctionMode,
  resolveTaskCategory,
  MARKETPLACE_AGENTS,
  MARKETPLACE_ETFS,
  mergeAuctionBids,
  mergeAuctionUpdates,
  mergeJobUpdates,
  buildCatalogBid,
  recordAgentFailure,
  recordAgentSuccess,
  resolveAgentServiceUrl,
  saveMarketplaceState,
  saveState,
  treasuryCredit,
  validateCustomBid,
  type MarketplaceJob,
  type QualityTier,
  type AuctionMode,
  type ReverseAuction,
  type SpendRecord,
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
import { enrichSpendPayer, spendInitiatorFromMarketplaceQuery } from "./ledger-payer.ts";
import { readWorkflowContext } from "./context-store.ts";
import { agentRunReadiness } from "./agent-runner.ts";
import { runPayerAgent } from "./payer-agent.ts";
import {
  getExternalAgentPolicy,
  loadExternalAgentRegistry,
  probeAndRegisterUrl,
  removeExternalAgent,
  getRegistryPath,
} from "./external-agent-registry.ts";
import {
  buildAuditPayload,
  buildBillPayload,
  buildChartPayload,
  buildCompetitorPayload,
  buildDefiPayload,
  buildMacroPayload,
  buildMarketPayload,
  buildNewsPayload,
  buildOnchainPayload,
  buildReportPayload,
  buildResearchPayload,
  buildRiskPayload,
  buildSentimentPayload,
  buildSubscriptionPayload,
  buildThesisPayload,
} from "./agent-services.ts";

type PaidRequest = Express.Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

type Gateway = ReturnType<typeof createGatewayMiddleware>;

interface AgentServiceDef {
  price: string;
  merchantId: string;
  category: SpendRecord["category"];
  policyAgent: SpendRecord["agent"];
  etaSeconds: number;
  payload: (req: PaidRequest) => Promise<unknown>;
}

function briefFrom(req: PaidRequest): string {
  return String(req.query.brief ?? "");
}

function contextFrom(req: PaidRequest): string {
  const contextId = String(req.query.contextId ?? "").trim();
  if (contextId) return readWorkflowContext(contextId);
  return String(req.query.context ?? "");
}

const AGENT_SERVICES: Record<string, AgentServiceDef> = {
  "news-agent": {
    price: "$0.01",
    merchantId: "research-summary",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 15,
    payload: (req) => buildNewsPayload(briefFrom(req)),
  },
  "market-agent": {
    price: "$0.001",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 5,
    payload: (req) => buildMarketPayload(briefFrom(req)),
  },
  "research-agent": {
    price: "$0.02",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 20,
    payload: (req) => buildResearchPayload(briefFrom(req), contextFrom(req)),
  },
  "sentiment-agent": {
    price: "$0.03",
    merchantId: "research-summary",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 12,
    payload: (req) => buildSentimentPayload(briefFrom(req)),
  },
  "chart-agent": {
    price: "$0.015",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 10,
    payload: (req) => buildChartPayload(briefFrom(req)),
  },
  "report-agent": {
    price: "$0.05",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 25,
    payload: (req) => buildReportPayload(briefFrom(req), contextFrom(req)),
  },
  "thesis-agent": {
    price: "$0.069",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 50,
    payload: (req) => buildThesisPayload(briefFrom(req), contextFrom(req)),
  },
  "audit-agent": {
    price: "$0.10",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "broker",
    etaSeconds: 45,
    payload: (req) => buildAuditPayload(briefFrom(req), String(req.query.contract ?? "")),
  },
  "defi-agent": {
    price: "$0.02",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 18,
    payload: (req) => buildDefiPayload(briefFrom(req)),
  },
  "macro-agent": {
    price: "$0.025",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 22,
    payload: (req) => buildMacroPayload(briefFrom(req)),
  },
  "onchain-agent": {
    price: "$0.018",
    merchantId: "price-feed",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 16,
    payload: (req) => buildOnchainPayload(briefFrom(req)),
  },
  "competitor-agent": {
    price: "$0.03",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 20,
    payload: (req) => buildCompetitorPayload(briefFrom(req)),
  },
  "risk-agent": {
    price: "$0.04",
    merchantId: "research-papers",
    category: "apis",
    policyAgent: "research",
    etaSeconds: 18,
    payload: (req) => buildRiskPayload(briefFrom(req), contextFrom(req)),
  },
  "bill-agent": {
    price: "$0.05",
    merchantId: "utility-quote",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 14,
    payload: (req) => buildBillPayload(briefFrom(req)),
  },
  "subscription-agent": {
    price: "$0.03",
    merchantId: "subscription-check",
    category: "bills",
    policyAgent: "bills",
    etaSeconds: 12,
    payload: (req) => buildSubscriptionPayload(briefFrom(req)),
  },
};

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

  function marketplacePaidHandler(agentId: string, svc: AgentServiceDef) {
    return async (req: PaidRequest, res: Response) => {
      const policyState = loadState(policyStatePath);
      const amountUsdc = req.payment ? formatUnits(BigInt(req.payment.amount), 6) : svc.price.replace("$", "");

      const decision = evaluateSpend(
        policyState.policy,
        { agent: svc.policyAgent, merchantId: svc.merchantId, amountUsdc, category: svc.category },
        policyState.records
      );

      if (!decision.allowed) {
        const payer = enrichSpendPayer(req.payment?.payer);
        const record: SpendRecord = {
          id: crypto.randomUUID(),
          at: Math.floor(Date.now() / 1000),
          agent: svc.policyAgent,
          category: svc.category,
          merchantId: svc.merchantId,
          amountUsdc,
          settlementId: req.payment?.transaction,
          payerAddress: payer.payerAddress,
          executorAddress: payer.executorAddress,
          initiator: spendInitiatorFromMarketplaceQuery(req.query as Record<string, unknown>),
          status: "blocked",
          reason: decision.reason,
        };
        saveState(appendRecord(policyState, record), policyStatePath);
        let mp = loadMp();
        mp = recordAgentFailure(mp, agentId);
        saveMp(mp);
        res.status(403).json({ error: decision.reason, agentId });
        return;
      }

      let data: unknown;
      try {
        data = await svc.payload(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent service failed";
        res.status(503).json({ error: message, agentId });
        return;
      }

      const payer = enrichSpendPayer(req.payment?.payer);
      const record: SpendRecord = {
        id: crypto.randomUUID(),
        at: Math.floor(Date.now() / 1000),
        agent: svc.policyAgent,
        category: svc.category,
        merchantId: svc.merchantId,
        amountUsdc,
        settlementId: req.payment?.transaction,
        payerAddress: payer.payerAddress,
        executorAddress: payer.executorAddress,
        initiator: spendInitiatorFromMarketplaceQuery(req.query as Record<string, unknown>),
        status: "settled",
      };
      saveState(appendRecord(policyState, record), policyStatePath);

      let mp = loadMp();
      mp = recordAgentSuccess(mp, agentId, amountUsdc, svc.etaSeconds);
      mp = treasuryCredit(mp, amountUsdc);
      saveMp(mp);

      res.json({
        agentId,
        marketplace: true,
        paid_by: req.payment?.payer,
        amount_usdc: amountUsdc,
        settlementId: req.payment?.transaction,
        reputation: mpCredits().find((c) => c.agentId === agentId)?.score,
        data,
      });
    };
  }

  for (const [agentId, svc] of Object.entries(AGENT_SERVICES)) {
    app.get(
      `/marketplace/agents/${agentId}/execute`,
      gateway.require(svc.price),
      marketplacePaidHandler(agentId, svc)
    );
  }

  // --- Control plane ---
  app.get("/api/marketplace", (_req, res) => {
    const external = listMarketplaceAgents().filter((a) => a.origin === "external").length;
    res.json({
      vision: "The economic layer for AI agents",
      tagline: "Discover, negotiate, pay — instantly via x402. No accounts. No API keys.",
      agents: listMarketplaceAgents().length,
      localAgents: MARKETPLACE_AGENTS.length,
      externalAgents: external,
      etfs: MARKETPLACE_ETFS.length,
      payment: "x402 USDC on Arc",
      openInternet: getExternalAgentPolicy().openDiscovery,
    });
  });

  app.get("/api/marketplace/agents", (_req, res) => {
    const mp = loadMp();
    const credits = mpCredits();
    const creditMap = new Map(credits.map((c) => [c.agentId, c]));
    res.json(
      listMarketplaceAgents().map((agent) => ({
        ...agent,
        approved: true,
        credit: creditMap.get(agent.id),
        quote: buildQuoteForAgent(agent, creditMap.get(agent.id)!, apiBase),
        serviceUrl: resolveAgentServiceUrl(agent, apiBase),
      }))
    );
  });

  app.get("/api/marketplace/agents/:id/quote", (req, res) => {
    const agent = getMarketplaceAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const mp = loadMp();
    const credit = mpCredits().find((c) => c.agentId === agent.id);
    if (!credit) {
      res.status(404).json({ error: "Credit score unavailable" });
      return;
    }
    res.json({
      ...buildQuoteForAgent(agent, credit, apiBase),
      capabilities: agent.capabilities,
      origin: agent.origin,
      x402Verified: agent.x402Verified,
    });
  });

  app.get("/api/marketplace/registry", (_req, res) => {
    const policy = getExternalAgentPolicy();
    const agents = listMarketplaceAgents({ includeUnapproved: true, includeDisabled: true });
    const approvedIds = getApprovedAgentIds(approvalsPath);
    res.json({
      policy: { ...policy, requireAgentApproval: requireAgentApproval() },
      registryPath,
      approvalsPath,
      approvedCount: approvedIds.size,
      agents: agents.map((a) => ({
        ...a,
        serviceUrl: resolveAgentServiceUrl(a, apiBase),
        approved: isAgentApproved(a.id, approvalsPath),
      })),
      local: agents.filter((a) => a.origin !== "external").length,
      external: agents.filter((a) => a.origin === "external").length,
    });
  });

  app.get("/api/marketplace/registry/approvals", (_req, res) => {
    res.json({
      requireAgentApproval: requireAgentApproval(),
      approvalsPath,
      approvedAgentIds: [...getApprovedAgentIds(approvalsPath)],
    });
  });

  app.post("/api/marketplace/registry/approvals", (req, res) => {
    const agentId = String(req.body?.agentId ?? "").trim();
    if (!agentId) {
      res.status(400).json({ error: "agentId required" });
      return;
    }
    const agent = getMarketplaceAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: "Unknown agent" });
      return;
    }
    const approved = req.body?.approved !== false;
    const ids = setAgentApproved(agentId, approved, approvalsPath);
    res.json({
      ok: true,
      agentId,
      approved: ids.has(agentId),
      approvedAgentIds: [...ids],
    });
  });

  app.get("/api/marketplace/registry/policy", (_req, res) => {
    res.json(getExternalAgentPolicy());
  });

  app.post("/api/marketplace/registry/probe", async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ error: "url required" });
      return;
    }
    try {
      const save = req.body?.save !== false;
      const { agent, probe, error } = await probeAndRegisterUrl(url, {
        name: req.body?.name ? String(req.body.name) : undefined,
        category: req.body?.category,
        save,
        registryPath,
      });
      if (!probe?.ok) {
        res.status(400).json({ probe: probe ?? { ok: false, error: error ?? "x402 probe failed" }, error: error ?? probe?.error });
        return;
      }
      res.json({ probe, agent, error });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Probe failed" });
    }
  });

  app.post("/api/marketplace/registry/agents", async (req, res) => {
    const url = String(req.body?.serviceUrl ?? req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ error: "serviceUrl required" });
      return;
    }
    const { agent, probe, error } = await probeAndRegisterUrl(url, {
      name: String(req.body?.name ?? "").trim() || undefined,
      category: req.body?.category,
      save: true,
      registryPath,
    });
    if (!agent) {
      res.status(400).json({ error: error ?? "Failed to register agent", probe });
      return;
    }
    res.status(201).json({ agent, probe });
  });

  app.delete("/api/marketplace/registry/agents", (req, res) => {
    const url = String(req.body?.serviceUrl ?? req.query?.serviceUrl ?? "").trim();
    if (!url) {
      res.status(400).json({ error: "serviceUrl required" });
      return;
    }
    const removed = removeExternalAgent(url, registryPath);
    if (!removed) {
      res.status(404).json({ error: "Agent not in registry" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/marketplace/etfs", (_req, res) => {
    res.json(MARKETPLACE_ETFS.filter((etf) => etfAgentsApproved(etf.agentIds, approvalsPath)));
  });

  app.get("/api/marketplace/credits", (_req, res) => {
    res.json(mpCredits());
  });

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

  // --- Autonomous payer agent (discover → negotiate → settle) ---
  app.get("/api/payer-agent/readiness", (_req, res) => {
    res.json(agentRunReadiness());
  });

  app.post("/api/payer-agent/run", async (req, res) => {
    const brief = String(req.body?.brief ?? "").trim();
    if (!brief) {
      res.status(400).json({ error: "brief required" });
      return;
    }
    if (!!req.body?.dryRun) {
      res.status(400).json({ error: "dryRun is disabled — payer agent executes real x402 payments" });
      return;
    }
    try {
      const result = await runPayerAgent({
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
        res.status(unavailable ? 503 : 200).json(result ?? { ok: false, error: "Payer agent returned no result" });
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Payer agent failed" });
    }
  });

  return startAuctionEngine({ statePath, sellerAddress, apiBase });
}
