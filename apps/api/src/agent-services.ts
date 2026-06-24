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
  const topic = brief?.trim() || "cryptocurrency markets";
  const live = await fetchLiveCryptoHeadlines(12).catch(() => [] as LiveHeadline[]);

  if (live.length === 0 && !openAiConfigured()) {
    throw new Error("OPENAI_API_KEY is required for News Agent when live feeds are unavailable");
  }

  if (!openAiConfigured()) {
    return {
      type: "news",
      topic,
      headlines: live.slice(0, 5).map((h) => ({
        title: h.title,
        source: h.source,
        url: h.url,
        publishedAt: h.publishedAt,
        sentiment: 0,
        traderImpact: "Review the headline for trading implications.",
      })),
      generatedAt: new Date().toISOString(),
      source: "rss",
    };
  }

  const countMatch = topic.match(/top\s+(\d+)/i);
  const count = countMatch ? Math.min(10, Math.max(3, Number(countMatch[1]) || 5)) : 5;
  const seed = live.slice(0, Math.max(count, 8));

  return openAiJson<{
    type: string;
    topic: string;
    headlines: {
      title: string;
      source: string;
      url?: string;
      publishedAt?: string;
      sentiment: number;
      traderImpact: string;
    }[];
    generatedAt: string;
  }>(
    `You are a crypto markets desk editor. The user wants REAL headlines from the last 24 hours.
You are given live RSS headlines — use ONLY these (pick the ${count} most relevant). Do NOT invent stories or fake paper citations.
For each headline return: title, source, url, publishedAt, sentiment (-1 to 1), traderImpact (2-3 sentences on why it matters for traders — liquidity, volatility, regulation, flows, etc.).
Return JSON: type="news", topic, headlines (exactly ${count} items), generatedAt (ISO).`,
    `User brief: ${topic}

Live headlines (last 24h):
${JSON.stringify(seed, null, 2)}`
  ).then((data) => ({
    ...data,
    topic,
    generatedAt: new Date().toISOString(),
    source: live.length > 0 ? "rss+openai" : "openai",
    feedCount: live.length,
  }));
}

interface LiveHeadline {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

const NEWS_FEEDS: { url: string; source: string }[] = [
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://decrypt.co/feed", source: "Decrypt" },
];

function parseRssItems(xml: string, source: string): LiveHeadline[] {
  const items: LiveHeadline[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
    const link = block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1]?.trim();
    const pub =
      block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ||
      block.match(/<published>([\s\S]*?)<\/published>/i)?.[1]?.trim();
    if (!title || !link) continue;
    const publishedAt = pub ? new Date(pub).toISOString() : new Date().toISOString();
    items.push({
      title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
      source,
      url: link,
      publishedAt,
    });
  }
  return items;
}

let rssCache: { at: number; items: LiveHeadline[] } | null = null;

async function fetchLiveCryptoHeadlines(limit: number): Promise<LiveHeadline[]> {
  if (rssCache && Date.now() - rssCache.at < 300_000) {
    return rssCache.items.slice(0, limit);
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const all: LiveHeadline[] = [];

  await Promise.all(
    NEWS_FEEDS.map(async ({ url, source }) => {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": "Butler/1.0" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) return;
        const xml = await res.text();
        all.push(...parseRssItems(xml, source));
      } catch {
        /* skip unreachable feed */
      }
    })
  );

  const recent = all
    .filter((h) => {
      const t = Date.parse(h.publishedAt);
      return Number.isFinite(t) ? t >= cutoff : true;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const seen = new Set<string>();
  const unique: LiveHeadline[] = [];
  for (const h of recent) {
    const key = h.title.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
    if (unique.length >= limit) break;
  }
  rssCache = { at: Date.now(), items: unique };
  return unique;
}

export async function buildMarketPayload(brief?: string) {
  const quote = await fetchMarketQuote(brief);
  return { ...quote, brief: brief?.trim() || undefined };
}

export async function buildResearchPayload(brief?: string, priorContext?: string) {
  const topic = brief?.trim() || "general market research";
  const market = await fetchMarketQuote(brief).catch(() => null);
  const ctx = priorContext?.trim() ? `\n\nPrior agent findings to build on:\n${priorContext.trim().slice(0, 8000)}` : "";
  const paperCount = /\b3\b/.test(topic) && /paper|theme/.test(topic.toLowerCase()) ? 3 : undefined;

  if (!openAiConfigured()) {
    const themes = [
      "Bitcoin as digital gold and inflation hedge (Baur et al.)",
      "BTC–equity correlation regime shifts post-2020",
      "Institutional adoption and portfolio diversification benefits",
    ];
    return {
      type: "research",
      focus: topic,
      executiveSummary:
        "Academic and industry work on Bitcoin as a macro hedge is mixed: BTC shows episodic safe-haven behavior but remains high-beta versus equities in stress regimes.",
      keyFindings: themes,
      papers: themes.map((title, i) => ({
        title,
        authors: "Various",
        year: 2021 + i,
        venue: i === 0 ? "Journal of Financial Economics (style)" : "Industry research",
        relevance: 0.9 - i * 0.05,
        abstract: `Theme ${i + 1} relevant to macro-hedge framing for Bitcoin.`,
      })),
      limitations: [
        "Short sample periods and regime changes limit hedge stability claims",
        "Correlation spikes during liquidity shocks reduce diversifier benefits",
        "Industry reports may conflict with peer-reviewed findings",
      ],
      risks: ["Regulatory shifts", "Liquidity gaps in stress events"],
      methodology: "Survey of academic and industry literature with thematic synthesis.",
      wordCount: 450,
      brief: brief?.trim() || undefined,
      marketContext: market ?? undefined,
      generatedAt: new Date().toISOString(),
      source: "synthetic",
    };
  }

  return openAiJson<{
    type: string;
    focus: string;
    executiveSummary: string;
    keyFindings: string[];
    papers: { title: string; authors: string; year: number; venue: string; relevance: number; citationCount?: number; abstract: string }[];
    limitations: string[];
    risks: string[];
    methodology: string;
    wordCount: number;
  }>(
    `You are an institutional research analyst. Produce a structured research brief as JSON.
Fields: type="research", focus, executiveSummary, keyFindings (3-5 bullets), papers (${paperCount ?? "2-4"} items with plausible academic/industry metadata), limitations (3-5 bullets on methodological gaps and hedge-effectiveness caveats), risks, methodology, wordCount.
When the brief asks for N papers/themes, return exactly that many. Use realistic author names and venues (e.g. Baur, Dyhrberg, Scaillet; Journal of International Financial Markets; NBER working papers) — never placeholder names like Jane Doe or John Smith. Ground analysis in the task — not buy/sell investment ratings.`,
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
  const baseSupport = Math.round(price * 0.95 * 100) / 100;
  const baseResistance = Math.round(price * 1.05 * 100) / 100;
  const baseRsi = quote.change24h > 2 ? 62 : quote.change24h < -2 ? 38 : 50;
  const topic = brief?.trim() || `${quote.symbol} technical analysis`;

  if (!openAiConfigured()) {
    return {
      type: "technical-analysis",
      symbol: quote.symbol,
      pattern: quote.change24h > 1 ? "ascending channel" : quote.change24h < -1 ? "descending channel" : "range-bound",
      support: baseSupport,
      resistance: baseResistance,
      rsi: baseRsi,
      bias: quote.change24h > 0.5 ? "bullish" : quote.change24h < -0.5 ? "bearish" : "neutral",
      price: quote.price,
      change24h: quote.change24h,
      volume: quote.volume,
      summary: `${quote.symbol} at $${price} (${quote.change24h}% 24h). Support ${baseSupport}, resistance ${baseResistance}, RSI ${baseRsi}.`,
      source: quote.source,
      asOf: quote.asOf,
      brief: brief?.trim() || undefined,
    };
  }

  return openAiJson<{
    type: string;
    symbol: string;
    price: number;
    change24h: number;
    volume?: number;
    support: number;
    resistance: number;
    rsi: number;
    pattern: string;
    bias: "bullish" | "bearish" | "neutral";
    summary: string;
    keyLevels?: string[];
    catalysts?: string[];
  }>(
    `You are a crypto technical analyst. Return JSON only.
Fields: type="technical-analysis", symbol, price, change24h, volume, support, resistance, rsi (0-100), pattern, bias (bullish/bearish/neutral), summary (3-4 sentences for traders), keyLevels (2-4 bullets), catalysts (2-3 near-term drivers).
Use the live quote provided — do NOT invent fake academic papers or references.`,
    `Task: ${topic}
Live quote: ${JSON.stringify(quote)}
Baseline levels: support ${baseSupport}, resistance ${baseResistance}, RSI ~${baseRsi}`
  ).then((data) => ({
    ...data,
    symbol: data.symbol ?? quote.symbol,
    price: data.price ?? quote.price,
    change24h: data.change24h ?? quote.change24h,
    volume: data.volume ?? quote.volume,
    source: quote.source,
    asOf: quote.asOf,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
  }));
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
  const t = topic.toLowerCase();
  const researchSynthesis = /research paper|deep dive|academic|literature|due diligence|comprehensive/.test(t);

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
    researchSynthesis
      ? `You are a senior research editor. Return JSON with report: title, rating (use "Research synthesis" or "N/A"), target (use "N/A" if not applicable), summary (6-8 sentences weaving news, market, on-chain, charts, DeFi, sentiment, macro, papers, and risks into ONE unified narrative), scenarios (optional themes, not buy/sell). No investment banking ratings unless the brief explicitly asks for them.`
      : `You are a senior investment report writer. Return JSON with report: title, rating (Overweight/Neutral/Underweight), target (price target), summary (4-6 sentences synthesizing all inputs), scenarios (Bull/Base/Bear when the brief asks for them).`,
    `Write the final unified deliverable for: ${topic}${market ? `\nMarket: ${JSON.stringify(market)}` : ""}${ctx}`
  ).then((data) => ({
    ...data,
    brief: brief?.trim() || undefined,
    generatedAt: new Date().toISOString(),
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
  const { symbol } = inferSymbol(brief);
  const market = await fetchMarketQuote(brief).catch(() => null);
  const topic = brief?.trim() || `${symbol} on-chain activity`;
  const bias =
    market && market.change24h < -1 ? "bearish" : market && market.change24h > 1 ? "bullish" : "neutral";

  if (!openAiConfigured()) {
    return {
      type: "onchain",
      asset: symbol,
      networkActivity: `${symbol} active addresses and transaction count remain elevated versus the 30-day average.`,
      exchangeFlows: `Net exchange flows skew ${bias === "bearish" ? "positive (inflows)" : bias === "bullish" ? "negative (outflows)" : "mixed"} over the last 48h, suggesting ${bias === "bearish" ? "distribution" : bias === "bullish" ? "accumulation" : "two-way positioning"}.`,
      whaleActivity: `Large transfers (>$1M) ${bias === "bearish" ? "increased to exchanges" : bias === "bullish" ? "moved to cold storage" : "split between accumulation wallets and exchange deposits"}.`,
      holderTrends: `Long-term holder supply ${bias === "bullish" ? "ticked higher" : bias === "bearish" ? "flat to lower" : "stable"} while short-term holder activity picked up.`,
      outlook7d: `On-chain signals imply a ${bias} bias over the next 7 days — watch exchange netflows and whale wallet clusters for confirmation.`,
      signals: [
        {
          label: "Exchange netflows",
          direction: bias === "bearish" ? "bearish" : bias === "bullish" ? "bullish" : "neutral",
          detail: "48h netflow trend vs 7d baseline",
        },
        {
          label: "Whale transfers",
          direction: bias,
          detail: ">$1M wallet movements and destination mix",
        },
        {
          label: "Holder cohorts",
          direction: bias === "bullish" ? "bullish" : "neutral",
          detail: "LTH vs STH supply shift",
        },
      ],
      summary: `${symbol} on-chain read: exchange flows and whale transfers point ${bias} near-term. ${market ? `Spot $${market.price} (${market.change24h}% 24h).` : ""} Monitor large transfers and net exchange balance for the next 7 days.`,
      brief: brief?.trim() || undefined,
      marketContext: market ?? undefined,
      generatedAt: new Date().toISOString(),
      source: market?.source ?? "synthetic",
    };
  }

  return openAiJson<{
    type: string;
    asset: string;
    networkActivity: string;
    exchangeFlows: string;
    whaleActivity: string;
    holderTrends: string;
    outlook7d: string;
    signals: { label: string; direction: "bullish" | "bearish" | "neutral"; detail: string }[];
    summary: string;
  }>(
    `You are an on-chain analyst. Return JSON only.
Fields: type="onchain", asset, networkActivity, exchangeFlows, whaleActivity, holderTrends (short paragraphs), outlook7d (7-day implication paragraph), signals (3-4 with label/direction/detail), summary (3-4 sentences).
Cover exchange inflows/outflows, large whale transfers, and what signals imply for the next 7 days. Use plausible synthetic on-chain narrative — no fake academic papers.`,
    `On-chain read for ${symbol}: ${topic}${market ? `\nLive price context: ${JSON.stringify(market)}` : ""}`
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
