/** Butler Agent Marketplace — agent-to-agent commerce via x402 (no accounts, no API keys). */

import { getMarketplaceAgent } from "./agent-registry.ts";

export type MarketplaceCategory =
  | "research"
  | "news"
  | "market-data"
  | "sentiment"
  | "reporting"
  | "audit"
  | "bills";

export interface AgentCreditScore {
  agentId: string;
  /** 0–100 composite (Uber × GitHub × on-chain reliability). */
  score: number;
  successRate: number;
  tasksCompleted: number;
  revenueUsdc: string;
  avgEtaSeconds: number;
  reliability: number;
}

export interface MarketplaceAgent {
  id: string;
  name: string;
  tagline: string;
  category: MarketplaceCategory;
  /** x402 service path on Butler API (GET, payment required). */
  servicePath: string;
  priceUsdc: string;
  etaSeconds: number;
  /** Maps to Butler policy merchant id for ledger + policy. */
  merchantId: string;
  policyAgent: "research" | "bills" | "broker";
  capabilities: string[];
  /** `external` agents are registered with absolute x402 URLs (open internet). */
  origin?: "local" | "external";
  /** Absolute HTTPS x402 endpoint for external agents. */
  serviceUrl?: string;
  domain?: string;
  enabled?: boolean;
  maxPriceUsdc?: string;
  x402Verified?: boolean;
  probedAt?: number;
  network?: string;
}

export interface AgentQuote {
  agentId: string;
  name: string;
  priceUsdc: string;
  etaSeconds: number;
  reputation: number;
  successRate: number;
  tasksCompleted: number;
  serviceUrl: string;
}

export interface AgentEtf {
  id: string;
  name: string;
  description: string;
  /** Ordered worker agents — pay once, entire workflow executes. */
  agentIds: string[];
  bundlePriceUsdc: string;
  etaSeconds: number;
}

export interface MarketplaceJobPlan {
  strategy: "etf" | "workflow" | "direct";
  agentIds: string[];
  etfId?: string;
  reason?: string;
  router?: string;
}

export interface MarketplaceJob {
  id: string;
  at: number;
  type: "direct" | "etf" | "auction";
  status: "pending" | "paying" | "running" | "completed" | "failed";
  requesterAgent?: string;
  targetAgentId?: string;
  etfId?: string;
  auctionId?: string;
  brief?: string;
  totalUsdc: string;
  steps: MarketplaceJobStep[];
  result?: unknown;
  error?: string;
  /** Human-readable deliverable text for the dashboard library. */
  summary?: string;
  plan?: MarketplaceJobPlan;
}

export interface MarketplaceJobStep {
  agentId: string;
  label: string;
  priceUsdc: string;
  status: "pending" | "paid" | "done" | "failed";
  settlementId?: string;
  output?: unknown;
  error?: string;
}

export type QualityTier = "brief" | "standard" | "full";
export type AuctionMode = "single" | "etf";

export interface ReverseAuction {
  id: string;
  at: number;
  status: "open" | "awarded" | "completed" | "cancelled";
  brief: string;
  category: MarketplaceCategory;
  minReputation: number;
  deadlineAt: number;
  bids: AuctionBid[];
  winnerId?: string;
  jobId?: string;
  /** brief = headlines/quotes; standard = category pool; full = research + report agents only. */
  qualityTier?: QualityTier;
  /** Max USDC the buyer will pay — bids above this are excluded from award. */
  maxBudgetUsdc?: string;
  /** single = one agent; etf = multi-agent workflow bundle. */
  auctionMode?: AuctionMode;
  /** Set when an ETF workflow wins the auction. */
  winnerEtfId?: string;
  /** Auto-award lowest bid when deadline hits (default true). */
  autoAward?: boolean;
  /** Competitive bid rounds completed. */
  bidRound?: number;
  lastRoundAt?: number;
  /** Seconds between automated undercut rounds. */
  bidIntervalSeconds?: number;
  /** Payer-agent run owns award/settlement — background engine must not auto-award. */
  payerAgentOwned?: boolean;
  events?: AuctionEvent[];
}

export interface AuctionBid {
  agentId: string;
  agentName: string;
  priceUsdc: string;
  etaSeconds: number;
  reputation: number;
  at: number;
  round?: number;
  /** Present when bid is from a multi-agent ETF workflow. */
  etfId?: string;
}

export interface AuctionEvent {
  at: number;
  kind: "opened" | "bid" | "round" | "awarded" | "expired" | "completed" | "cancelled";
  agentId?: string;
  agentName?: string;
  priceUsdc?: string;
  message?: string;
  round?: number;
}

export interface AgentTreasury {
  label: string;
  balanceUsdc: string;
  spentUsdc: string;
  depositAddress: string;
  /** On-chain visibility — every payment traceable. */
  chain: string;
  autoSpend: boolean;
}

/** Worker agents — each is an x402 service (machine-to-machine paywall). */
export const MARKETPLACE_AGENTS: MarketplaceAgent[] = [
  {
    id: "news-agent",
    name: "News Agent",
    tagline: "Headlines & briefs from live feeds",
    category: "news",
    servicePath: "/marketplace/agents/news-agent/execute",
    priceUsdc: "0.01",
    etaSeconds: 15,
    merchantId: "research-summary",
    policyAgent: "research",
    capabilities: ["headlines", "summaries", "tickers"],
  },
  {
    id: "market-agent",
    name: "Market Agent",
    tagline: "Realtime price & liquidity snapshots",
    category: "market-data",
    servicePath: "/marketplace/agents/market-agent/execute",
    priceUsdc: "0.001",
    etaSeconds: 5,
    merchantId: "price-feed",
    policyAgent: "research",
    capabilities: ["quotes", "ohlc", "volume"],
  },
  {
    id: "research-agent",
    name: "Research Agent",
    tagline: "Premium papers, executive summaries & deep dives",
    category: "research",
    servicePath: "/marketplace/agents/research-agent/execute",
    priceUsdc: "0.02",
    etaSeconds: 20,
    merchantId: "research-papers",
    policyAgent: "research",
    capabilities: ["papers", "citations", "analysis"],
  },
  {
    id: "sentiment-agent",
    name: "Sentiment Agent",
    tagline: "Social & news sentiment scoring",
    category: "sentiment",
    servicePath: "/marketplace/agents/sentiment-agent/execute",
    priceUsdc: "0.03",
    etaSeconds: 12,
    merchantId: "subscription-check",
    policyAgent: "research",
    capabilities: ["sentiment", "trends", "signals"],
  },
  {
    id: "chart-agent",
    name: "Chart Agent",
    tagline: "Technical chart patterns & levels",
    category: "market-data",
    servicePath: "/marketplace/agents/chart-agent/execute",
    priceUsdc: "0.015",
    etaSeconds: 10,
    merchantId: "price-feed",
    policyAgent: "research",
    capabilities: ["charts", "support-resistance", "indicators"],
  },
  {
    id: "thesis-agent",
    name: "Thesis Agent",
    tagline: "Full investment thesis in one pass — price, on-chain, DeFi, scenarios",
    category: "reporting",
    servicePath: "/marketplace/agents/thesis-agent/execute",
    priceUsdc: "0.069",
    etaSeconds: 50,
    merchantId: "utility-quote",
    policyAgent: "bills",
    capabilities: ["thesis", "btc", "scenarios", "defi", "on-chain", "executive-report"],
  },
  {
    id: "report-agent",
    name: "Report Agent",
    tagline: "Synthesizes multi-source investment reports",
    category: "reporting",
    servicePath: "/marketplace/agents/report-agent/execute",
    priceUsdc: "0.05",
    etaSeconds: 25,
    merchantId: "utility-quote",
    policyAgent: "bills",
    capabilities: ["reports", "pdf-ready", "executive-summary"],
  },
  {
    id: "audit-agent",
    name: "Audit Agent",
    tagline: "Solidity & smart-contract security scans",
    category: "audit",
    servicePath: "/marketplace/agents/audit-agent/execute",
    priceUsdc: "0.10",
    etaSeconds: 45,
    merchantId: "utility-quote",
    policyAgent: "broker",
    capabilities: ["solidity", "slither", "gas-review"],
  },
  {
    id: "defi-agent",
    name: "DeFi Agent",
    tagline: "Protocol yields, TVL trends & DeFi risk map",
    category: "market-data",
    servicePath: "/marketplace/agents/defi-agent/execute",
    priceUsdc: "0.02",
    etaSeconds: 18,
    merchantId: "price-feed",
    policyAgent: "research",
    capabilities: ["defi", "yield", "tvl", "protocols"],
  },
  {
    id: "macro-agent",
    name: "Macro Agent",
    tagline: "Fed, rates, CPI & cross-asset macro briefings",
    category: "research",
    servicePath: "/marketplace/agents/macro-agent/execute",
    priceUsdc: "0.025",
    etaSeconds: 22,
    merchantId: "research-papers",
    policyAgent: "research",
    capabilities: ["macro", "fed", "rates", "cpi", "economy"],
  },
  {
    id: "onchain-agent",
    name: "On-Chain Agent",
    tagline: "Flows, whales & network activity narratives",
    category: "market-data",
    servicePath: "/marketplace/agents/onchain-agent/execute",
    priceUsdc: "0.018",
    etaSeconds: 16,
    merchantId: "price-feed",
    policyAgent: "research",
    capabilities: ["onchain", "whales", "flows", "holders"],
  },
  {
    id: "competitor-agent",
    name: "Competitor Agent",
    tagline: "Moats, market share & competitive positioning",
    category: "research",
    servicePath: "/marketplace/agents/competitor-agent/execute",
    priceUsdc: "0.03",
    etaSeconds: 20,
    merchantId: "research-papers",
    policyAgent: "research",
    capabilities: ["competitors", "moat", "strategy", "market-share"],
  },
  {
    id: "risk-agent",
    name: "Risk Agent",
    tagline: "Portfolio risk scoring & hedge suggestions",
    category: "reporting",
    servicePath: "/marketplace/agents/risk-agent/execute",
    priceUsdc: "0.04",
    etaSeconds: 18,
    merchantId: "utility-quote",
    policyAgent: "research",
    capabilities: ["risk", "hedge", "volatility", "drawdown"],
  },
  {
    id: "bill-agent",
    name: "Bill Agent",
    tagline: "Utility & invoice quote structuring",
    category: "bills",
    servicePath: "/marketplace/agents/bill-agent/execute",
    priceUsdc: "0.05",
    etaSeconds: 14,
    merchantId: "utility-quote",
    policyAgent: "bills",
    capabilities: ["utility", "invoice", "bill", "quote"],
  },
  {
    id: "subscription-agent",
    name: "Subscription Agent",
    tagline: "Recurring spend audit & savings recommendations",
    category: "bills",
    servicePath: "/marketplace/agents/subscription-agent/execute",
    priceUsdc: "0.03",
    etaSeconds: 12,
    merchantId: "subscription-check",
    policyAgent: "bills",
    capabilities: ["subscription", "saas", "recurring", "audit"],
  },
];

/** Pay once — entire agent workflow executes via chained x402. */
export const MARKETPLACE_ETFS: AgentEtf[] = [
  {
    id: "crypto-research-etf",
    name: "Crypto Research ETF",
    description: "Market → sentiment → news → consolidated report",
    agentIds: ["market-agent", "sentiment-agent", "news-agent", "report-agent"],
    bundlePriceUsdc: "0.105",
    etaSeconds: 62,
  },
  {
    id: "nvidia-investment-report",
    name: "Investment Research ETF",
    description: "News → market data → deep research → investment report",
    agentIds: ["news-agent", "market-agent", "research-agent", "report-agent"],
    bundlePriceUsdc: "0.081",
    etaSeconds: 65,
  },
  {
    id: "bill-audit-bundle",
    name: "Bill Intelligence Bundle",
    description: "Utility quotes + subscription audit + spend sentiment",
    agentIds: ["bill-agent", "subscription-agent", "sentiment-agent"],
    bundlePriceUsdc: "0.085",
    etaSeconds: 38,
  },
  {
    id: "btc-onchain-etf",
    name: "BTC On-Chain ETF",
    description: "Price → on-chain flows → charts → DeFi context → research → report",
    agentIds: ["market-agent", "onchain-agent", "chart-agent", "defi-agent", "research-agent", "report-agent"],
    bundlePriceUsdc: "0.115",
    etaSeconds: 104,
  },
  {
    id: "btc-full-thesis-etf",
    name: "BTC Full Thesis ETF",
    description:
      "Express BTC investment thesis — live price, on-chain flows, support/resistance, DeFi, risks, bull/base/bear report (~1 min)",
    agentIds: ["thesis-agent"],
    bundlePriceUsdc: "0.069",
    etaSeconds: 55,
  },
  {
    id: "macro-radar-etf",
    name: "Macro Radar ETF",
    description: "Headlines → macro briefing → sentiment → markets → report",
    agentIds: ["news-agent", "macro-agent", "sentiment-agent", "market-agent", "report-agent"],
    bundlePriceUsdc: "0.105",
    etaSeconds: 84,
  },
  {
    id: "defi-alpha-etf",
    name: "DeFi Alpha ETF",
    description: "DeFi protocols → live quote → sentiment → technical levels",
    agentIds: ["defi-agent", "market-agent", "sentiment-agent", "chart-agent"],
    bundlePriceUsdc: "0.06",
    etaSeconds: 51,
  },
];

export const DEFAULT_TREASURY: AgentTreasury = {
  label: "Agent DAO Treasury",
  balanceUsdc: "0.00",
  spentUsdc: "0",
  depositAddress: "0x0000000000000000000000000000000000000000",
  chain: "eip155:5042002",
  autoSpend: true,
};

/** @deprecated Use `getMarketplaceAgent` from agent-registry (re-exported). */
export function getLocalMarketplaceAgent(id: string): MarketplaceAgent | undefined {
  return MARKETPLACE_AGENTS.find((a) => a.id === id);
}

export function getMarketplaceEtf(id: string): AgentEtf | undefined {
  return MARKETPLACE_ETFS.find((e) => e.id === id);
}

export function computeCreditScore(stats: {
  tasksCompleted: number;
  tasksSucceeded: number;
  revenueUsdc: string;
  avgEtaSeconds: number;
}): Omit<AgentCreditScore, "agentId"> {
  const tasksCompleted = stats.tasksCompleted;
  const successRate = tasksCompleted > 0 ? stats.tasksSucceeded / tasksCompleted : 1;
  const revenue = Number(stats.revenueUsdc) || 0;
  const reliability = Math.min(1, successRate * 0.6 + (tasksCompleted > 10 ? 0.25 : tasksCompleted * 0.025) + (revenue > 1 ? 0.15 : revenue * 0.15));
  const score = Math.round(Math.min(100, successRate * 55 + reliability * 35 + Math.min(tasksCompleted, 50) * 0.2));
  return {
    score,
    successRate: Math.round(successRate * 1000) / 10,
    tasksCompleted,
    revenueUsdc: stats.revenueUsdc,
    avgEtaSeconds: stats.avgEtaSeconds,
    reliability: Math.round(reliability * 1000) / 10,
  };
}

export function buildQuote(agent: MarketplaceAgent, credit: AgentCreditScore, serviceUrl?: string): AgentQuote {
  return {
    agentId: agent.id,
    name: agent.name,
    priceUsdc: agent.priceUsdc,
    etaSeconds: agent.etaSeconds,
    reputation: credit.score,
    successRate: credit.successRate,
    tasksCompleted: credit.tasksCompleted,
    serviceUrl: serviceUrl ?? agent.serviceUrl ?? agent.servicePath,
  };
}

function bidWithinBudget(priceUsdc: string, maxBudgetUsdc?: string): boolean {
  if (!maxBudgetUsdc) return true;
  const cap = Number(maxBudgetUsdc);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  return Number(priceUsdc) <= cap + 1e-9;
}

/** Rank ETF workflows by task fit (higher = better match). */
export function scoreEtfForBrief(
  etf: AgentEtf,
  brief: string,
  qualityTier: QualityTier = "standard"
): number {
  const t = brief.toLowerCase();
  let score = 0;

  if (etf.id === "btc-full-thesis-etf") {
    if (/btc|bitcoin/.test(t)) score += 25;
    if (/thesis|investment|bull|bear|scenario|executive|deep dive|comprehensive|full/.test(t)) score += 20;
    if (/whale|on-chain|onchain|exchange flow|defi|aave|uniswap|support|resistance|macro|risk/.test(t)) score += 15;
    if (!/btc|bitcoin/.test(t)) score -= 45;
  }

  if (etf.id === "btc-onchain-etf") {
    if (/btc|bitcoin/.test(t)) score += 18;
    else score -= 40;
  }

  if (etf.id === "defi-alpha-etf" && /defi|yield|tvl|uniswap|aave/.test(t)) score += 18;
  if (etf.id === "macro-radar-etf" && /macro|fed|rates|cpi|inflation|economy/.test(t)) score += 18;
  if (etf.id === "crypto-research-etf" && /crypto|btc|eth|sol/.test(t)) score += 12;
  if (etf.id === "bill-audit-bundle" && /bill|subscription|utility|invoice/.test(t)) score += 20;

  if (etf.id === "nvidia-investment-report") {
    if (/nvda|nvidia|tsla|aapl|msft|stock|equity|share/.test(t)) score += 22;
    else score -= 40;
  }

  if (/full|comprehensive|deep dive|thesis|multi.?agent|all agents/.test(t)) {
    if (etf.id === "btc-full-thesis-etf" && /btc|bitcoin/.test(t)) score += 35;
    else score += Math.min(etf.agentIds.length, 4) * 2;
  }

  if (qualityTier === "full") {
    if (etf.id === "btc-full-thesis-etf" && /btc|bitcoin/.test(t)) score += 45;
    else if (etf.agentIds.includes("research-agent") && etf.agentIds.includes("report-agent")) score += 12;
  }

  for (const agentId of etf.agentIds) {
    const agent = getMarketplaceAgent(agentId);
    if (!agent) continue;
    for (const cap of agent.capabilities) {
      if (cap.length > 3 && t.includes(cap)) score += 2;
    }
  }

  return score;
}

/** Reverse auction winner: ETF pipelines by best brief fit; single agents by lowest price. */
export function pickAuctionWinner(
  auction: ReverseAuction,
  credits: Map<string, AgentCreditScore>
): AuctionBid | null {
  let eligible = auction.bids.filter((b) => {
    if (b.etfId) return bidWithinBudget(b.priceUsdc, auction.maxBudgetUsdc);
    return (credits.get(b.agentId)?.score ?? 0) >= auction.minReputation;
  });
  eligible = eligible.filter((b) => bidWithinBudget(b.priceUsdc, auction.maxBudgetUsdc));
  if (eligible.length === 0) return null;

  const etfBids = eligible.filter((b) => b.etfId);
  if (etfBids.length > 0 && (auction.auctionMode === "etf" || etfBids.length === eligible.length)) {
    return etfBids.sort((a, b) => {
      const etfA = MARKETPLACE_ETFS.find((e) => e.id === a.etfId);
      const etfB = MARKETPLACE_ETFS.find((e) => e.id === b.etfId);
      const scoreA = etfA ? scoreEtfForBrief(etfA, auction.brief, auction.qualityTier ?? "standard") : 0;
      const scoreB = etfB ? scoreEtfForBrief(etfB, auction.brief, auction.qualityTier ?? "standard") : 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return Number(a.priceUsdc) - Number(b.priceUsdc);
    })[0]!;
  }

  return eligible.sort((a, b) => {
    const pa = Number(a.priceUsdc);
    const pb = Number(b.priceUsdc);
    if (pa !== pb) return pa - pb;
    return (credits.get(b.agentId)?.score ?? 0) - (credits.get(a.agentId)?.score ?? 0);
  })[0]!;
}

export function etfTotalPrice(etf: AgentEtf, agents: MarketplaceAgent[]): string {
  let micro = 0n;
  for (const id of etf.agentIds) {
    const a = agents.find((x) => x.id === id);
    if (!a) continue;
    const [w, f = ""] = a.priceUsdc.split(".");
    micro += BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  }
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}
