import {
  getMarketplaceAgent,
  listMarketplaceAgents,
  type AgentCreditScore,
  type AuctionBid,
  type AuctionEvent,
  type MarketplaceCategory,
  type QualityTier,
  type ReverseAuction,
} from "./agent-registry.ts";
import { buildQuote, MARKETPLACE_ETFS, pickAuctionWinner, scoreEtfForBrief } from "./marketplace.ts";

export { scoreEtfForBrief } from "./marketplace.ts";

const MIN_BID_INCREMENT = 0.001;
const MAX_DISCOUNT_RATE = 0.15;

/** Which agent categories may bid on an auction category. */
const BID_POOLS: Record<string, MarketplaceCategory[]> = {
  audit: ["audit"],
  research: ["research", "news", "sentiment", "reporting"],
  news: ["news", "research"],
  "market-data": ["market-data"],
  sentiment: ["sentiment", "research", "news"],
  reporting: ["reporting", "research"],
  bills: ["bills", "reporting", "sentiment"],
};

/** Agent IDs allowed per quality tier (standard = use category pool only). */
const QUALITY_TIER_AGENTS: Record<QualityTier, string[] | null> = {
  brief: ["news-agent", "market-agent", "chart-agent", "sentiment-agent", "onchain-agent"],
  standard: null,
  full: ["research-agent", "report-agent", "macro-agent", "defi-agent"],
};

function bidWithinBudget(priceUsdc: string, maxBudgetUsdc?: string): boolean {
  if (!maxBudgetUsdc) return true;
  const cap = Number(maxBudgetUsdc);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  return Number(priceUsdc) <= cap + 1e-9;
}

export function etfsEligibleForAuction(
  auction: Pick<ReverseAuction, "brief" | "category" | "maxBudgetUsdc" | "qualityTier">
) {
  const t = auction.brief.toLowerCase();
  const tier = auction.qualityTier ?? "standard";
  const wantsBtcThesis =
    /btc|bitcoin/.test(t) &&
    /thesis|investment|bull|bear|whale|on-chain|onchain|defi|support|resistance|executive|deep|comprehensive|scenario/.test(t);

  return MARKETPLACE_ETFS.filter((etf) => {
    if (!bidWithinBudget(etf.bundlePriceUsdc, auction.maxBudgetUsdc)) return false;
    if (tier === "brief") return false;
    if (auction.category === "audit") return etf.agentIds.includes("audit-agent");
    if (auction.category === "bills") return etf.id === "bill-audit-bundle";

    if (wantsBtcThesis) {
      return etf.id === "btc-full-thesis-etf" || etf.id === "btc-onchain-etf";
    }

    if (tier === "full" || auction.category === "reporting" || auction.category === "research") {
      if (!etf.agentIds.includes("research-agent") || !etf.agentIds.includes("report-agent")) return false;
      if (etf.id === "nvidia-investment-report" && !/nvda|nvidia|tsla|aapl|msft|stock|equity/.test(t)) return false;
      return true;
    }
    if (/crypto|btc|eth|sol|onchain|on-chain|defi/.test(t)) {
      return (
        etf.id === "btc-onchain-etf" ||
        etf.id === "btc-full-thesis-etf" ||
        etf.id === "defi-alpha-etf" ||
        etf.id === "crypto-research-etf"
      );
    }
    if (/macro|fed|rates|cpi|economy|inflation/.test(t)) return etf.id === "macro-radar-etf";
    if (/report|investment|nvda|nvidia|stock|equity/.test(t)) {
      return etf.agentIds.includes("report-agent");
    }
    return etf.agentIds.includes("research-agent");
  });
}

export function agentsEligibleForAuction(
  auction: Pick<ReverseAuction, "category" | "minReputation" | "qualityTier" | "auctionMode">,
  credits: Map<string, AgentCreditScore>
) {
  if (auction.auctionMode === "etf") return [];

  const pool = BID_POOLS[auction.category] ?? [auction.category as MarketplaceCategory];
  const tier = auction.qualityTier ?? "standard";
  const tierAgents = QUALITY_TIER_AGENTS[tier];

  return listMarketplaceAgents().filter((agent) => {
    if (!pool.includes(agent.category)) return false;
    if (tierAgents && !tierAgents.includes(agent.id)) return false;
    const score = credits.get(agent.id)?.score ?? 0;
    return score >= auction.minReputation;
  });
}

export function formatBidPrice(value: number): string {
  if (value < 0.01) return value.toFixed(4).replace(/\.?0+$/, "") || "0.001";
  return value.toFixed(3).replace(/\.?0+$/, "") || "0";
}

export function bidFloorPrice(listPriceUsdc: string): number {
  const list = Number(listPriceUsdc);
  return Math.max(MIN_BID_INCREMENT, list * (1 - MAX_DISCOUNT_RATE));
}

export function buildCatalogBid(
  agentId: string,
  credits: Map<string, AgentCreditScore>,
  at = Math.floor(Date.now() / 1000),
  round?: number
): AuctionBid | null {
  const agent = getMarketplaceAgent(agentId);
  if (!agent) return null;
  const credit = credits.get(agentId);
  if (!credit) return null;
  const quote = buildQuote(agent, credit);
  return {
    agentId: agent.id,
    agentName: agent.name,
    priceUsdc: quote.priceUsdc,
    etaSeconds: quote.etaSeconds,
    reputation: quote.reputation,
    at,
    round,
  };
}

export function solicitCatalogBids(
  auction: ReverseAuction,
  credits: AgentCreditScore[],
  round = 1
): AuctionBid[] {
  if (auction.auctionMode === "etf") {
    return solicitEtfBids(auction, round);
  }

  const creditMap = new Map(credits.map((c) => [c.agentId, c]));
  const at = Math.floor(Date.now() / 1000);
  const eligible = agentsEligibleForAuction(auction, creditMap);
  const bids: AuctionBid[] = [];

  for (const agent of eligible) {
    const bid = buildCatalogBid(agent.id, creditMap, at, round);
    if (bid && bidWithinBudget(bid.priceUsdc, auction.maxBudgetUsdc)) bids.push(bid);
  }

  return bids.sort((a, b) => Number(a.priceUsdc) - Number(b.priceUsdc));
}

export function solicitEtfBids(auction: ReverseAuction, round = 1): AuctionBid[] {
  const at = Math.floor(Date.now() / 1000);
  return etfsEligibleForAuction(auction)
    .map((etf) => ({
      bid: {
        agentId: etf.agentIds[0]!,
        etfId: etf.id,
        agentName: etf.name,
        priceUsdc: etf.bundlePriceUsdc,
        etaSeconds: etf.etaSeconds,
        reputation: 99,
        at,
        round,
      },
      score: scoreEtfForBrief(etf, auction.brief, auction.qualityTier ?? "standard"),
    }))
    .filter(({ bid }) => bidWithinBudget(bid.priceUsdc, auction.maxBudgetUsdc))
    .sort((a, b) => b.score - a.score || Number(a.bid.priceUsdc) - Number(b.bid.priceUsdc))
    .map(({ bid }) => bid);
}

export function mergeAuctionBids(existing: AuctionBid[], incoming: AuctionBid[]): AuctionBid[] {
  const byAgent = new Map<string, AuctionBid>();
  for (const bid of existing) byAgent.set(bid.agentId, bid);
  for (const bid of incoming) {
    const prev = byAgent.get(bid.agentId);
    if (!prev || Number(bid.priceUsdc) < Number(prev.priceUsdc)) {
      byAgent.set(bid.agentId, bid);
    }
  }
  return [...byAgent.values()].sort((a, b) => Number(a.priceUsdc) - Number(b.priceUsdc));
}

export function validateCustomBid(agentId: string, priceUsdc: string): { ok: true } | { ok: false; error: string } {
  const agent = getMarketplaceAgent(agentId);
  if (!agent) return { ok: false, error: "Unknown agent" };
  const price = Number(priceUsdc);
  const list = Number(agent.priceUsdc);
  const floor = bidFloorPrice(agent.priceUsdc);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "Invalid bid price" };
  if (price > list) {
    return { ok: false, error: `Bid cannot exceed agent list price ($${agent.priceUsdc})` };
  }
  if (price < floor - 1e-9) {
    return { ok: false, error: `Bid cannot go below floor ($${formatBidPrice(floor)})` };
  }
  return { ok: true };
}

export function leadingBid(
  auction: ReverseAuction,
  credits: Map<string, AgentCreditScore>
): AuctionBid | null {
  return pickAuctionWinner(auction, credits);
}

export function auctionSecondsLeft(auction: ReverseAuction, now = Math.floor(Date.now() / 1000)): number {
  return Math.max(0, auction.deadlineAt - now);
}

export function appendAuctionEvent(auction: ReverseAuction, event: AuctionEvent): ReverseAuction {
  const events = [...(auction.events ?? []), event].slice(-40);
  return { ...auction, events };
}

/** One automated undercut round — non-leaders cut price toward the leader. */
export function runCompetitiveBidRound(
  auction: ReverseAuction,
  credits: AgentCreditScore[],
  now = Math.floor(Date.now() / 1000)
): { auction: ReverseAuction; improved: boolean } {
  const creditMap = new Map(credits.map((c) => [c.agentId, c]));
  const round = (auction.bidRound ?? 0) + 1;
  const leader = leadingBid(auction, creditMap);
  const leaderPrice = leader ? Number(leader.priceUsdc) : Infinity;

  let bids = [...auction.bids];
  let improved = false;
  let next = auction;

  for (const agent of agentsEligibleForAuction(auction, creditMap)) {
    const list = Number(agent.priceUsdc);
    const floor = bidFloorPrice(agent.priceUsdc);
    const current = bids.find((b) => b.agentId === agent.id);
    const currentPrice = current ? Number(current.priceUsdc) : list;

    let target = leaderPrice < Infinity ? leaderPrice - MIN_BID_INCREMENT : list;
    if (target < floor) target = floor;
    if (target >= currentPrice - 1e-9) continue;

    const base = buildCatalogBid(agent.id, creditMap, now, round);
    if (!base) continue;

    const bid: AuctionBid = { ...base, priceUsdc: formatBidPrice(target) };
    bids = mergeAuctionBids(bids, [bid]);
    improved = true;
    next = appendAuctionEvent(next, {
      at: now,
      kind: "bid",
      agentId: agent.id,
      agentName: agent.name,
      priceUsdc: bid.priceUsdc,
      round,
      message: `${agent.name} undercut to $${bid.priceUsdc}`,
    });
  }

  if (improved) {
    next = appendAuctionEvent(next, {
      at: now,
      kind: "round",
      round,
      message: `Round ${round} — ${bids.length} active bids`,
    });
  }

  return {
    auction: {
      ...next,
      bids,
      bidRound: round,
      lastRoundAt: now,
    },
    improved,
  };
}

export interface AuctionTickResult {
  auction: ReverseAuction;
  needsAward: boolean;
  expired: boolean;
}

/** Advance bidding rounds and detect deadline / auto-award. */
export function processAuctionTick(
  auction: ReverseAuction,
  credits: AgentCreditScore[],
  now = Math.floor(Date.now() / 1000)
): AuctionTickResult {
  if (auction.status !== "open") {
    return { auction, needsAward: false, expired: false };
  }

  const interval = auction.bidIntervalSeconds ?? 12;
  const lastRound = auction.lastRoundAt ?? auction.at;
  const secondsLeft = auctionSecondsLeft(auction, now);
  let current = auction;

  if (secondsLeft > 0 && now - lastRound >= interval && auction.auctionMode !== "etf") {
    const round = runCompetitiveBidRound(current, credits, now);
    current = round.auction;
  }

  if (secondsLeft <= 0) {
    const capped = current.maxBudgetUsdc
      ? { ...current, bids: current.bids.filter((b) => bidWithinBudget(b.priceUsdc, current.maxBudgetUsdc)) }
      : current;

    if (capped.bids.length === 0) {
      const reason = current.bids.length > 0 ? "No bids within max budget" : "Expired with no bids";
      return {
        auction: appendAuctionEvent(
          { ...capped, status: "cancelled" },
          { at: now, kind: "cancelled", message: reason }
        ),
        needsAward: false,
        expired: true,
      };
    }

    if (capped.autoAward !== false) {
      return {
        auction: appendAuctionEvent(capped, {
          at: now,
          kind: "expired",
          message:
            capped.auctionMode === "etf"
              ? "Deadline reached — auto-awarding best-matching ETF"
              : "Deadline reached — auto-awarding lowest bid",
        }),
        needsAward: true,
        expired: true,
      };
    }

    return {
      auction: appendAuctionEvent(
        { ...capped, status: "cancelled" },
        { at: now, kind: "expired", message: "Deadline reached (manual award only)" }
      ),
      needsAward: false,
      expired: true,
    };
  }

  return { auction: current, needsAward: false, expired: false };
}

export function initializeAuction(params: {
  brief: string;
  category: ReverseAuction["category"];
  minReputation: number;
  ttlSeconds: number;
  autoAward?: boolean;
  bidIntervalSeconds?: number;
  payerAgentOwned?: boolean;
  qualityTier?: QualityTier;
  maxBudgetUsdc?: string;
  auctionMode?: ReverseAuction["auctionMode"];
  credits: AgentCreditScore[];
  now?: number;
}): ReverseAuction {
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const auctionMode = params.auctionMode ?? "single";
  let auction: ReverseAuction = {
    id: crypto.randomUUID(),
    at: now,
    status: "open",
    brief: params.brief,
    category: params.category,
    minReputation: params.minReputation,
    deadlineAt: now + params.ttlSeconds,
    bids: [],
    qualityTier: params.qualityTier ?? "standard",
    maxBudgetUsdc: params.maxBudgetUsdc,
    auctionMode,
    autoAward: params.autoAward !== false,
    bidRound: 0,
    lastRoundAt: now,
    bidIntervalSeconds: params.bidIntervalSeconds ?? 12,
    payerAgentOwned: params.payerAgentOwned,
    events: [],
  };

  auction.bids = solicitCatalogBids(auction, params.credits, 1);
  const opener =
    auctionMode === "etf"
      ? `ETF pipeline auction — ${auction.bids.length} workflows eligible`
      : `RFP open — ${auction.bids.length} agents submitted opening bids`;
  auction = appendAuctionEvent(auction, {
    at: now,
    kind: "opened",
    message: opener,
    round: 1,
  });

  if (auctionMode === "etf") {
    return auction;
  }

  const competitive = runCompetitiveBidRound(
    { ...auction, bidRound: 0, lastRoundAt: now - (auction.bidIntervalSeconds ?? 12) },
    params.credits,
    now
  );
  return competitive.auction;
}

export function inferAuctionCategory(brief: string): MarketplaceCategory {
  const t = brief.toLowerCase();
  const wantsDeepResearch = /research|paper|papers|report|investment thesis|deep dive|analysis|comprehensive|due diligence/.test(
    t
  );
  if (/audit|security|contract|solidity|slither/.test(t)) return "audit";
  if (/bill|subscription|utility|invoice|recurring/.test(t)) return "bills";
  if (/defi|yield|tvl|uniswap|aave|liquidity pool/.test(t)) return "market-data";
  if (/macro|fed\b|rates|cpi|inflation|economy/.test(t)) return "research";
  if (/onchain|on-chain|whale|exchange flow|holder/.test(t)) return "market-data";
  if (/competitor|moat|market share|vs\.|versus/.test(t)) return "research";
  if (/risk|hedge|drawdown|volatility/.test(t)) return "reporting";
  if (/report|investment thesis|synthesize|briefing|full report/.test(t)) return "reporting";
  if (!wantsDeepResearch && /price|market|\bstock\b|crypto|btc|eth|nvda|quote/.test(t)) return "market-data";
  if (/news|headline|headlines/.test(t)) return "news";
  if (/sentiment|social|bullish|bearish/.test(t)) return "sentiment";
  return "research";
}

export function resolveTaskCategory(
  brief: string,
  userCategory?: MarketplaceCategory,
  qualityTier?: QualityTier
): MarketplaceCategory {
  const cat = userCategory ?? inferAuctionCategory(brief);
  if (qualityTier === "full" && (cat === "research" || cat === "news" || cat === "market-data")) {
    return "reporting";
  }
  return cat;
}

export function defaultAuctionMode(
  qualityTier?: QualityTier,
  explicit?: ReverseAuction["auctionMode"]
): NonNullable<ReverseAuction["auctionMode"]> {
  if (explicit) return explicit;
  return qualityTier === "full" ? "etf" : "single";
}
