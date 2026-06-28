/**
 * Global agent registry — read for all users; writes restricted to seller wallet.
 * Loaded in lite API mode so the Agent network tab works without full x402 bundle.
 */
import type { Express, Request, Response } from "express";
import { dirname, resolve } from "node:path";
import {
  buildQuoteForAgent,
  getAgentCredits,
  getApprovedAgentIds,
  getMarketplaceAgent,
  initAgentApprovals,
  isAgentApproved,
  listMarketplaceAgents,
  loadMarketplaceState,
  MARKETPLACE_AGENTS,
  MARKETPLACE_ETFS,
  requireAgentApproval,
  resolveAgentServiceUrl,
  setAgentApproved,
  etfAgentsApproved,
} from "@butler/core";
import {
  getExternalAgentPolicy,
  getRegistryPath,
  loadExternalAgentRegistry,
  probeAndRegisterUrl,
  removeExternalAgent,
} from "./external-agent-registry.ts";

export type RegistryRoutesOpts = {
  apiBase: string;
  statePath: string;
  sellerAddress: string;
};

function assertRegistrySeller(req: Request, res: Response, sellerAddress: string): boolean {
  const seller = sellerAddress.toLowerCase();
  const adminKey = process.env.BUTLER_REGISTRY_ADMIN_KEY?.trim();
  const key = String(req.headers["x-butler-registry-key"] ?? "").trim();
  if (adminKey && key === adminKey) return true;

  const wallet = String(req.headers["x-butler-seller-wallet"] ?? req.body?.sellerWallet ?? "").toLowerCase();
  if (wallet && wallet === seller) return true;

  res.status(403).json({
    error: "Only the Butler seller wallet can add or modify agents on the network",
    sellerAddress,
  });
  return false;
}

export function registerRegistryRoutes(app: Express, opts: RegistryRoutesOpts): void {
  const { apiBase, statePath, sellerAddress } = opts;
  const registryPath = getRegistryPath();
  const approvalsPath =
    process.env.BUTLER_AGENT_APPROVALS_PATH?.trim() ||
    resolve(dirname(statePath), "agent-approvals.json");

  initAgentApprovals(approvalsPath);
  loadExternalAgentRegistry({ registryPath });

  function mpCredits() {
    return getAgentCredits(loadMarketplaceState(statePath, sellerAddress), getExternalAgentPolicy().baselineReputation);
  }

  app.get("/api/marketplace", (_req, res) => {
    const external = listMarketplaceAgents().filter((a) => a.origin === "external").length;
    res.json({
      vision: "Micropayment infrastructure for autonomous agents",
      tagline: "Discover, negotiate, pay — instantly via x402. No accounts. No API keys.",
      agents: listMarketplaceAgents().length,
      localAgents: MARKETPLACE_AGENTS.length,
      externalAgents: external,
      etfs: MARKETPLACE_ETFS.length,
      payment: "x402 USDC on Arc",
      openInternet: getExternalAgentPolicy().openDiscovery,
      sellerAddress,
    });
  });

  app.get("/api/marketplace/agents", (_req, res) => {
    const credits = mpCredits();
    const creditMap = new Map(credits.map((c) => [c.agentId, c]));
    res.json(
      listMarketplaceAgents().map((agent) => ({
        ...agent,
        approved: isAgentApproved(agent.id, approvalsPath),
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
      sellerAddress,
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
      sellerAddress,
    });
  });

  app.post("/api/marketplace/registry/approvals", (req, res) => {
    if (!assertRegistrySeller(req, res, sellerAddress)) return;
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
    res.json({ ...getExternalAgentPolicy(), sellerAddress });
  });

  app.post("/api/marketplace/registry/probe", async (req, res) => {
    if (!assertRegistrySeller(req, res, sellerAddress)) return;
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
      if (agent) setAgentApproved(agent.id, true, approvalsPath);
      res.json({ probe, agent, error });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Probe failed" });
    }
  });

  app.post("/api/marketplace/registry/agents", async (req, res) => {
    if (!assertRegistrySeller(req, res, sellerAddress)) return;
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
    setAgentApproved(agent.id, true, approvalsPath);
    res.status(201).json({ agent, probe });
  });

  app.delete("/api/marketplace/registry/agents", (req, res) => {
    if (!assertRegistrySeller(req, res, sellerAddress)) return;
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
}
