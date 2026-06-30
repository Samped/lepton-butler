/** Browser-safe copy — keep in sync with packages/core/src/brief-intent.ts */

export type ExpressCategory = "news" | "market-data" | "sentiment" | "research" | "audit" | "bills";

export interface ExpressBrief {
  category: ExpressCategory;
  agentId: string;
  label: string;
}

export function wantsDeepBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  return (
    /research paper|deep dive|full report|investment report|investment thesis|comprehensive|due diligence|multi.?agent|all agents|in-depth analysis|thorough analysis/.test(
      t
    ) && !isLightLiteratureBrief(brief)
  );
}

function isLightLiteratureBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  return (
    (/executive summary/.test(t) || /research summary/.test(t)) &&
    /paper|theme|limitation|academic|literature|industry|hedge/.test(t) &&
    !/research paper|deep dive|full report|comprehensive|due diligence|multi.?agent/.test(t)
  );
}

export function resolveDeepWorkRouting(brief: string): { qualityTier: "full"; auctionMode: "etf" } | null {
  if (wantsDeepBrief(brief)) return { qualityTier: "full", auctionMode: "etf" };
  return resolveBtcPipelineRouting(brief);
}

/** BTC on-chain + DeFi briefs need the multi-agent BTC ETF, not a single on-chain agent. */
export function resolveBtcPipelineRouting(brief: string): { qualityTier: "full"; auctionMode: "etf" } | null {
  const t = brief.toLowerCase();
  if (!/\b(btc|bitcoin)\b/.test(t)) return null;
  if (!/on[- ]?chain|onchain|whale|exchange flow|defi|decentralized finance/.test(t)) return null;
  if (isChartOnlyBrief(brief) || isMarketQuoteBrief(brief)) return null;
  return { qualityTier: "full", auctionMode: "etf" };
}

export function isHeadlineOnlyBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  const wantsHeadlines =
    /headline|headlines|top\s+\d+.*(news|headline)|crypto news|news from the last|news summary|news feed/.test(t) ||
    (/summarize/.test(t) && /news|headline/.test(t));
  return wantsHeadlines && !wantsDeepBrief(brief);
}

export function isResearchLiteratureBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  if (wantsDeepBrief(brief) || isSoliditySourceBrief(brief)) return false;
  const wantsLiterature =
    /academic|literature review|industry research|key papers?|papers?\/themes|themes and limitations|research on\b|research summary|survey of|state of the art|macro hedge/.test(
      t
    ) ||
    (/executive summary/.test(t) && /research|paper|academic|literature|industry|hedge|theme/.test(t)) ||
    (/research/.test(t) && /paper|theme|limitation|academic|industry|hedge/.test(t));
  return wantsLiterature && !isHeadlineOnlyBrief(brief);
}

export function isChartOnlyBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  const wantsChart =
    /technical analysis|technicals\b|chart analysis|\brsi\b|support.*resistance|resistance.*support|short-term bias|trading bias|key support|key resistance/.test(
      t
    ) || (/support|resistance/.test(t) && /\brsi\b|bias|bullish|bearish|neutral|pattern/.test(t));
  return wantsChart && !wantsDeepBrief(brief);
}

export function isSoliditySourceBrief(brief: string): boolean {
  return /pragma\s+solidity/i.test(brief) && /contract\s+\w+/i.test(brief);
}

export function isAuditOnlyBrief(brief: string): boolean {
  if (wantsDeepBrief(brief)) return false;
  const t = brief.toLowerCase();
  if (isSoliditySourceBrief(brief)) return true;
  return (
    /\baudit\b|security audit|vulnerabilit|slither|smart contract audit|contract audit|solidity audit|security scan/.test(
      t
    ) && /solidity|smart contract|\bcontract\b|reentrancy|vulnerable|pragma/.test(t)
  );
}

export function isBillOnlyBrief(brief: string): boolean {
  if (wantsDeepBrief(brief)) return false;
  const t = brief.toLowerCase();
  if (isSoliditySourceBrief(brief) || isAuditOnlyBrief(brief)) return false;
  return (
    /utility bill|electricity bill|energy bill|gas bill|water bill|invoice quote|bill quote|monthly bill/.test(t) ||
    (/\bbill\b/.test(t) && /utility|electric|energy|kwh|pg&e|pge|provider|due date/.test(t))
  );
}

export function isOnchainOnlyBrief(brief: string): boolean {
  if (isAuditOnlyBrief(brief) || isSoliditySourceBrief(brief)) return false;
  const t = brief.toLowerCase();
  const wantsOnchain =
    /on[- ]?chain|whale|exchange inflow|exchange outflow|exchange flows?|large transfers?|holder trends?|network activity/.test(
      t
    ) ||
    ((/inflow|outflow/.test(t) || /\btransfer(s)?\b/.test(t)) &&
      /\b(exchange|btc|bitcoin|eth|ethereum|solana|crypto|whale)\b/.test(t) &&
      !/pragma\s+solidity|smart contract/.test(t));
  const alsoWantsDefi = /\bdefi\b|decentralized finance|defi exposure/.test(t);
  return wantsOnchain && !alsoWantsDefi && !wantsDeepBrief(brief) && !isChartOnlyBrief(brief);
}

export function isMarketQuoteBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  const wantsPrice =
    /current price|live price|spot price|price of|quote for|how much is/.test(t) ||
    ((/price|quote/.test(t) || /\b(btc|eth|sol|nvda|aapl|msft|tsla)\b/.test(t)) &&
      !/technical|rsi|support|headline|news|thesis|research|report|sentiment|defi|onchain|on-chain|whale|inflow|outflow|transfer|analysis/.test(t));
  return wantsPrice && !wantsDeepBrief(brief) && !isChartOnlyBrief(brief) && !isOnchainOnlyBrief(brief);
}

export function isSentimentOnlyBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  const wantsSentiment = /sentiment score|sentiment analysis|market mood|social sentiment/.test(t);
  return wantsSentiment && !wantsDeepBrief(brief) && !isChartOnlyBrief(brief);
}

export function resolveExpressBrief(brief: string): ExpressBrief | null {
  if (isAuditOnlyBrief(brief)) {
    return { category: "audit", agentId: "audit-agent", label: "contract audit" };
  }
  if (isBillOnlyBrief(brief)) {
    return { category: "bills", agentId: "bill-agent", label: "utility bill quote" };
  }
  if (isHeadlineOnlyBrief(brief)) {
    return { category: "news", agentId: "news-agent", label: "headlines" };
  }
  if (isResearchLiteratureBrief(brief)) {
    return { category: "research", agentId: "research-agent", label: "research literature" };
  }
  if (isChartOnlyBrief(brief)) {
    return { category: "market-data", agentId: "chart-agent", label: "technical analysis" };
  }
  if (isOnchainOnlyBrief(brief)) {
    return { category: "market-data", agentId: "onchain-agent", label: "on-chain analysis" };
  }
  if (isMarketQuoteBrief(brief)) {
    return { category: "market-data", agentId: "market-agent", label: "market quote" };
  }
  if (isSentimentOnlyBrief(brief)) {
    return { category: "sentiment", agentId: "sentiment-agent", label: "sentiment" };
  }
  return null;
}
