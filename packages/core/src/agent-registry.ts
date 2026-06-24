import {
  MARKETPLACE_AGENTS,
  type AgentQuote,
  type AgentCreditScore,
  type MarketplaceAgent,
  type MarketplaceCategory,
} from "./marketplace.ts";
import { isAgentApproved, requireAgentApproval } from "./agent-approvals.ts";

export type AgentOrigin = "local" | "external";

/** External agents use absolute `serviceUrl`; local agents use `servicePath` on the Butler API. */
export type RegistryAgent = MarketplaceAgent & {
  origin: AgentOrigin;
  serviceUrl?: string;
  domain?: string;
  enabled?: boolean;
  maxPriceUsdc?: string;
  x402Verified?: boolean;
  probedAt?: number;
  network?: string;
};

let externalAgents: RegistryAgent[] = [];
let ephemeralAgents: RegistryAgent[] = [];

export function registerExternalAgents(agents: RegistryAgent[]): void {
  externalAgents = agents.map(normalizeExternalAgent);
}

export function registerEphemeralAgents(agents: RegistryAgent[]): void {
  ephemeralAgents = agents.map(normalizeExternalAgent);
}

export function clearEphemeralAgents(): void {
  ephemeralAgents = [];
}

function normalizeExternalAgent(agent: RegistryAgent): RegistryAgent {
  const serviceUrl = agent.serviceUrl?.trim();
  let domain = agent.domain;
  if (!domain && serviceUrl) {
    try {
      domain = new URL(serviceUrl).hostname;
    } catch {
      domain = undefined;
    }
  }
  return {
    ...agent,
    origin: "external",
    serviceUrl,
    domain,
    enabled: agent.enabled !== false,
    servicePath: agent.servicePath || "",
    merchantId: agent.merchantId || `external:${agent.id}`,
    policyAgent: agent.policyAgent || "research",
  };
}

export function listMarketplaceAgents(opts?: {
  includeDisabled?: boolean;
  includeUnapproved?: boolean;
}): RegistryAgent[] {
  const local: RegistryAgent[] = MARKETPLACE_AGENTS.map((a) => ({ ...a, origin: "local" as const }));
  const remote = [...externalAgents, ...ephemeralAgents].filter((a) => opts?.includeDisabled || a.enabled !== false);
  const byId = new Map<string, RegistryAgent>();
  for (const a of local) byId.set(a.id, a);
  for (const a of remote) byId.set(a.id, a);
  let agents = [...byId.values()];
  if (!opts?.includeUnapproved && requireAgentApproval()) {
    agents = agents.filter((a) => isAgentApproved(a.id));
  }
  return agents;
}

/** Agents that may bid, be paid, or appear in task catalogs. */
export function listActiveMarketplaceAgents(): RegistryAgent[] {
  return listMarketplaceAgents();
}

export function getMarketplaceAgent(id: string): RegistryAgent | undefined {
  return listMarketplaceAgents({ includeDisabled: true, includeUnapproved: true }).find((a) => a.id === id);
}

export function isExternalAgent(agent: Pick<RegistryAgent, "origin" | "serviceUrl">): boolean {
  return agent.origin === "external" || !!agent.serviceUrl;
}

export function resolveAgentServiceUrl(agent: RegistryAgent, apiBase: string): string {
  if (agent.serviceUrl?.startsWith("http")) return agent.serviceUrl;
  const base = apiBase.replace(/\/$/, "");
  const path = agent.servicePath.startsWith("/") ? agent.servicePath : `/${agent.servicePath}`;
  return `${base}${path}`;
}

export function buildQuoteForAgent(agent: RegistryAgent, credit: AgentCreditScore, apiBase: string): AgentQuote {
  return {
    agentId: agent.id,
    name: agent.name,
    priceUsdc: agent.priceUsdc,
    etaSeconds: agent.etaSeconds,
    reputation: credit.score,
    successRate: credit.successRate,
    tasksCompleted: credit.tasksCompleted,
    serviceUrl: resolveAgentServiceUrl(agent, apiBase),
  };
}

export function externalBaselineCredit(agent: RegistryAgent, baselineScore = 72): AgentCreditScore {
  return {
    agentId: agent.id,
    score: baselineScore,
    successRate: 100,
    tasksCompleted: 0,
    revenueUsdc: "0",
    avgEtaSeconds: agent.etaSeconds,
    reliability: 85,
  };
}

export function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "").split("/").filter(Boolean).pop() ?? "agent";
    return `${u.hostname}-${path}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 48);
  } catch {
    return `agent-${Date.now()}`;
  }
}

export function inferCategoryFromCapabilities(
  capabilities: string[],
  brief?: string
): MarketplaceCategory {
  const text = [...capabilities, brief ?? ""].join(" ").toLowerCase();
  if (/audit|security|solidity/.test(text)) return "audit";
  if (/report|brief/.test(text)) return "reporting";
  if (/market|price|quote/.test(text)) return "market-data";
  if (/news|headline/.test(text)) return "news";
  if (/sentiment/.test(text)) return "sentiment";
  return "research";
}
