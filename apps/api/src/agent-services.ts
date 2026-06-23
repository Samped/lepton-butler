import { openAiConfigured, openAiJson } from "./openai-client.ts";

const CRYPTO_IDS: Record<string, string> = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  usdc: "usd-coin",
};

const STOCK_TICKERS = new Set(["nvda", "aapl", "msft", "goog", "googl", "amzn", "meta", "tsla", "amd", "intc"]);

export function inferSymbol(brief?: string): { symbol: string; kind: "crypto" | "stock" | "unknown" } {
  const t = (brief ?? "").toLowerCase();
  if (/bitcoin|btc\b/.test(t)) return { symbol: "BTC", kind: "crypto" };
  if (/ethereum|eth\b/.test(t)) return { symbol: "ETH", kind: "crypto" };
  if (/solana|sol\b/.test(t)) return { symbol: "SOL", kind: "crypto" };
  if (/nvidia|nvda/.test(t)) return { symbol: "NVDA", kind: "stock" };
  if (/apple|aapl/.test(t)) return { symbol: "AAPL", kind: "stock" };
  if (/microsoft|msft/.test(t)) return { symbol: "MSFT", kind: "stock" };
  if (/tesla|tsla/.test(t)) return { symbol: "TSLA", kind: "stock" };
  const match = brief?.match(/\b([A-Z]{2,5})\b/);
  if (match) {
    const sym = match[1]!.toLowerCase();
    if (CRYPTO_IDS[sym]) return { symbol: match[1]!, kind: "crypto" };
    if (STOCK_TICKERS.has(sym)) return { symbol: match[1]!, kind: "stock" };
  }
  return { symbol: "BTC", kind: "crypto" };
}

async function fetchCryptoQuote(symbol: string) {
  const id = CRYPTO_IDS[symbol.toLowerCase()] ?? symbol.toLowerCase();
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko quote failed (${res.status})`);
  const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number; usd_24h_vol?: number }>;
  const row = data[id];
  if (!row?.usd) throw new Error(`No quote for ${symbol}`);
  return {
    symbol: symbol.toUpperCase(),
    price: row.usd,
    change24h: row.usd_24h_change ?? 0,
    volume: row.usd_24h_vol ?? 0,
    source: "coingecko",
    asOf: new Date().toISOString(),
  };
}

async function fetchStockQuote(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Butler/1.0" } });
  if (!res.ok) throw new Error(`Yahoo Finance quote failed (${res.status})`);
  const data = (await res.json()) as {
    chart?: { result?: { meta?: { regularMarketPrice?: number; previousClose?: number; regularMarketVolume?: number } }[] };
  };
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error(`No quote for ${symbol}`);
  const prev = meta.previousClose ?? meta.regularMarketPrice;
  const change24h = prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0;
  return {
    symbol: symbol.toUpperCase(),
    price: meta.regularMarketPrice,
    change24h,
    volume: meta.regularMarketVolume ?? 0,
    source: "yahoo-finance",
    asOf: new Date().toISOString(),
  };
}

export async function fetchMarketQuote(brief?: string) {
  const { symbol, kind } = inferSymbol(brief);
  if (kind === "stock") return fetchStockQuote(symbol);
  if (kind === "crypto") return fetchCryptoQuote(symbol);
  return fetchCryptoQuote(symbol);
}

export async function buildNewsPayload(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for News Agent");
  }
  const topic = brief?.trim() || "global markets and technology";
  return openAiJson<{
    headlines: { title: string; source: string; sentiment: number; publishedAt?: string }[];
    ticker?: string;
    topic: string;
    generatedAt: string;
  }>(
    `You are a financial news analyst. Return JSON with recent-style headlines relevant to the user's topic.
Use plausible public news framing. sentiment is -1 to 1. Include 3-5 headlines.`,
    `Topic: ${topic}`
  ).then((data) => ({
    ...data,
    topic,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildMarketPayload(brief?: string) {
  const quote = await fetchMarketQuote(brief);
  return { ...quote, brief: brief?.trim() || undefined };
}

export async function buildResearchPayload(brief?: string, priorContext?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Research Agent");
  }
  const topic = brief?.trim() || "general market research";
  const market = await fetchMarketQuote(brief).catch(() => null);
  const ctx = priorContext?.trim() ? `\n\nPrior agent findings to build on:\n${priorContext.trim().slice(0, 8000)}` : "";

  return openAiJson<{
    type: string;
    focus: string;
    executiveSummary: string;
    keyFindings: string[];
    papers: { title: string; authors: string; year: number; venue: string; relevance: number; citationCount?: number; abstract: string }[];
    risks: string[];
    methodology: string;
    wordCount: number;
  }>(
    `You are an institutional research analyst. Produce a structured research brief as JSON.
Fields: type="research", focus, executiveSummary, keyFindings (4-6 bullets), papers (2-4 real-style academic/industry papers with plausible metadata), risks, methodology, wordCount.
Ground analysis in the task brief. Not investment advice.`,
    `Task brief: ${topic}${market ? `\n\nLive market context: ${JSON.stringify(market)}` : ""}${ctx}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    marketContext: market ?? undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildSentimentPayload(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Sentiment Agent");
  }
  const topic = brief?.trim() || "crypto and equities";
  const market = await fetchMarketQuote(brief).catch(() => null);

  return openAiJson<{
    score: number;
    label: string;
    sources: number;
    trending: string[];
    drivers: string[];
  }>(
    `You are a sentiment analyst. Return JSON: score (0-1), label (bearish/neutral/bullish), sources (estimated count), trending (topics), drivers (2-4 bullets).`,
    `Analyze sentiment for: ${topic}${market ? `\nMarket: ${JSON.stringify(market)}` : ""}`
  ).then((data) => ({
    ...data,
    topic,
    marketContext: market ?? undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildChartPayload(brief?: string) {
  const quote = await fetchMarketQuote(brief);
  const price = quote.price;
  const support = Math.round(price * 0.95 * 100) / 100;
  const resistance = Math.round(price * 1.05 * 100) / 100;
  const rsi = quote.change24h > 2 ? 62 : quote.change24h < -2 ? 38 : 50;
  return {
    symbol: quote.symbol,
    pattern: quote.change24h > 1 ? "ascending channel" : quote.change24h < -1 ? "descending channel" : "range-bound",
    support,
    resistance,
    rsi,
    price: quote.price,
    change24h: quote.change24h,
    source: quote.source,
    asOf: quote.asOf,
    brief: brief?.trim() || undefined,
  };
}

export async function buildThesisPayload(brief?: string, priorContext?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Thesis Agent");
  }
  const topic = brief?.trim() || "BTC investment thesis";
  const { symbol } = inferSymbol(brief);
  const market = await fetchMarketQuote(brief).catch(() => null);
  const price = market?.price ?? 62_000;
  const support = Math.round(price * 0.95 * 100) / 100;
  const resistance = Math.round(price * 1.05 * 100) / 100;
  const rsi = market && market.change24h > 2 ? 62 : market && market.change24h < -2 ? 38 : 50;
  const ctx = priorContext?.trim() ? `\n\nAdditional context:\n${priorContext.trim().slice(0, 4000)}` : "";

  return openAiJson<{
    type: "investment-thesis";
    symbol: string;
    liveMarket: { price: number; change24h: number; volume: number; asOf: string; source: string };
    technicals: { support: number; resistance: number; rsi: number; pattern: string };
    onchain: {
      exchangeFlows: string;
      whaleActivity: string;
      networkActivity: string;
      signals: { label: string; direction: string; detail: string }[];
    };
    defi: {
      aaveExposure: string;
      uniswapExposure: string;
      summary: string;
      topProtocols: { name: string; exposure: string; risk: string }[];
    };
    risks: string[];
    report: {
      title: string;
      rating: string;
      target: string;
      executiveSummary: string;
      scenarios: { name: string; description: string; probability: string; priceTarget?: string }[];
    };
    generatedAt: string;
  }>(
    `You are a senior crypto investment strategist. Return JSON type="investment-thesis" with:
- symbol, liveMarket (use provided live quote)
- technicals (support/resistance/rsi/pattern from provided levels)
- onchain (exchangeFlows, whaleActivity, networkActivity, signals[3-4])
- defi (aaveExposure, uniswapExposure, summary, topProtocols[2-3] for Aave/Uniswap BTC exposure)
- risks (4-6 bullets: on-chain, regulatory, macro, liquidity)
- report (title, rating Overweight/Neutral/Underweight, target price, executiveSummary 4-6 sentences, scenarios Bull/Base/Bear with probability and priceTarget)
Be specific to the brief. Plausible institutional framing. Not financial advice.`,
    `Task: ${topic}
Symbol: ${symbol}
Live market: ${JSON.stringify(market ?? { price, change24h: 0, volume: 0, source: "estimate" })}
Technicals: support ${support}, resistance ${resistance}, RSI ${rsi}${ctx}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildReportPayload(brief?: string, priorContext?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Report Agent");
  }
  const topic = brief?.trim() || "investment analysis";
  const market = await fetchMarketQuote(brief).catch(() => null);
  const ctx = priorContext?.trim()
    ? `\n\nSynthesize ALL prior specialist agent outputs into one cohesive report:\n${priorContext.trim().slice(0, 10000)}`
    : "";

  return openAiJson<{
    report: {
      title: string;
      rating: string;
      target: string;
      summary: string;
      scenarios?: { name: string; description: string; probability?: string }[];
      generatedAt: string;
    };
  }>(
    `You are a senior investment report writer. Return JSON with report: title, rating (Overweight/Neutral/Underweight), target (price target), summary (4-6 sentences synthesizing all inputs), scenarios (Bull/Base/Bear when the brief asks for them).`,
    `Write the final executive report for: ${topic}${market ? `\nMarket: ${JSON.stringify(market)}` : ""}${ctx}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    marketContext: market ?? undefined,
    source: "openai",
  }));
}

export async function buildAuditPayload(brief?: string, contract?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Audit Agent");
  }
  const target = contract?.trim() || brief?.trim() || "smart contract security review";

  return openAiJson<{
    contract: string;
    findings: { severity: string; title: string; detail: string }[];
    summary: string;
  }>(
    `You are a smart contract security auditor. Return JSON: contract (name), findings (severity: critical/high/medium/low/info, title, detail), summary.
Focus on common Solidity risks: access control, reentrancy, integer issues, centralization, upgrade patterns.`,
    `Audit request: ${target}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildResearchSummary(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for research summary");
  }
  const topic = brief?.trim() || "Arc nanopayments and agent commerce";
  return openAiJson<{ summary: string; sources: number; topics: string[] }>(
    `Return JSON: summary (2-3 sentence executive summary), sources (count), topics (3-5 tags).`,
    `Summarize research on: ${topic}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildUtilityQuote(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for utility quotes");
  }
  const request = brief?.trim() || "monthly electricity bill";
  return openAiJson<{
    provider: string;
    amountDue: number;
    dueDate: string;
    lineItems: { label: string; amount: number }[];
    notes: string;
  }>(
    `You parse utility bill requests into structured quotes. Return JSON with provider, amountDue (USD number), dueDate (ISO date ~30 days out), lineItems, notes.
Base estimates on typical US utility pricing when specifics are missing; state assumptions in notes.`,
    `Quote request: ${request}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildDefiPayload(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for DeFi Agent");
  }
  const topic = brief?.trim() || "DeFi market overview";
  const market = await fetchMarketQuote(brief).catch(() => null);

  return openAiJson<{
    type: string;
    focus: string;
    tvlTrend: string;
    topProtocols: { name: string; chain: string; tvlUsd: string; yieldApy: string; risk: string }[];
    opportunities: string[];
    risks: string[];
    summary: string;
  }>(
    `You are a DeFi analyst. Return JSON: type="defi", focus, tvlTrend (1 sentence), topProtocols (3-4 with plausible testnet-era data), opportunities (bullets), risks (bullets), summary (2 sentences). Not financial advice.`,
    `DeFi analysis for: ${topic}${market ? `\nToken context: ${JSON.stringify(market)}` : ""}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    marketContext: market ?? undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildMacroPayload(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Macro Agent");
  }
  const topic = brief?.trim() || "global macro outlook";

  return openAiJson<{
    type: string;
    focus: string;
    regime: string;
    keyIndicators: { name: string; value: string; implication: string }[];
    fedOutlook: string;
    crossAssetView: string;
    scenarios: { name: string; probability: string; impact: string }[];
    summary: string;
  }>(
    `You are a macro strategist. Return JSON: type="macro", focus, regime (risk-on/off/mixed), keyIndicators (3-4: CPI, rates, DXY, etc.), fedOutlook, crossAssetView, scenarios (2-3), summary. Plausible current-era framing.`,
    `Macro briefing for: ${topic}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildOnchainPayload(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for On-Chain Agent");
  }
  const { symbol } = inferSymbol(brief);
  const market = await fetchMarketQuote(brief).catch(() => null);

  return openAiJson<{
    type: string;
    asset: string;
    networkActivity: string;
    exchangeFlows: string;
    whaleActivity: string;
    holderTrends: string;
    signals: { label: string; direction: "bullish" | "bearish" | "neutral"; detail: string }[];
    summary: string;
  }>(
    `You are an on-chain analyst. Return JSON: type="onchain", asset, networkActivity, exchangeFlows, whaleActivity, holderTrends (short paragraphs), signals (3-4 with label/direction/detail), summary. Use plausible synthetic on-chain narrative.`,
    `On-chain read for ${symbol}: ${brief?.trim() || "recent activity"}${market ? `\nPrice: ${JSON.stringify(market)}` : ""}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    marketContext: market ?? undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildCompetitorPayload(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Competitor Agent");
  }
  const topic = brief?.trim() || "competitive landscape";

  return openAiJson<{
    type: string;
    subject: string;
    competitors: { name: string; moat: string; weakness: string; marketShare: string }[];
    positioning: string;
    threats: string[];
    opportunities: string[];
    summary: string;
  }>(
    `You are a strategy consultant. Return JSON: type="competitor", subject, competitors (3-5 with moat/weakness/marketShare), positioning, threats, opportunities, summary.`,
    `Competitive analysis: ${topic}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildRiskPayload(brief?: string, priorContext?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for Risk Agent");
  }
  const topic = brief?.trim() || "portfolio risk assessment";
  const market = await fetchMarketQuote(brief).catch(() => null);
  const ctx = priorContext?.trim() ? `\n\nContext from prior agents:\n${priorContext.trim().slice(0, 6000)}` : "";

  return openAiJson<{
    type: string;
    focus: string;
    riskScore: number;
    riskLabel: string;
    factors: { name: string; severity: "low" | "medium" | "high"; note: string }[];
    hedges: string[];
    summary: string;
  }>(
    `You are a risk officer. Return JSON: type="risk", focus, riskScore (0-100), riskLabel, factors (4-6), hedges (2-3 suggestions), summary. Not investment advice.`,
    `Risk review: ${topic}${market ? `\nMarket: ${JSON.stringify(market)}` : ""}${ctx}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    marketContext: market ?? undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

export async function buildSubscriptionAudit(brief?: string) {
  if (!openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for subscription audit");
  }
  const request = brief?.trim() || "audit recurring subscriptions";
  return openAiJson<{
    subscriptions: { name: string; amount: number; nextBill: string; category: string }[];
    monthlyTotal: number;
    recommendations: string[];
  }>(
    `You audit subscription spending. Return JSON: subscriptions (name, amount USD, nextBill ISO date, category), monthlyTotal, recommendations (2-3 savings tips).
If user lists services in the brief, include them; otherwise provide a template audit structure.`,
    `Subscription audit: ${request}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    source: "openai",
  }));
}

/** Marketplace agent aliases */
export const buildBillPayload = buildUtilityQuote;
export const buildSubscriptionPayload = buildSubscriptionAudit;
