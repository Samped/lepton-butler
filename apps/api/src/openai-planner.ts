import {
  MARKETPLACE_AGENTS,
  MARKETPLACE_ETFS,
  buildTaskPlanFromRoute,
  type AgentCreditScore,
  type TaskPlan,
  type TaskStrategy,
} from "@butler/core";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

export interface OpenAiPlannerStatus {
  enabled: boolean;
  model: string;
}

interface LlmRouteResponse {
  strategy?: TaskStrategy;
  etfId?: string | null;
  agentIds?: string[];
  reason?: string;
}

function catalogForPrompt(credits: AgentCreditScore[]): string {
  const creditById = new Map(credits.map((c) => [c.agentId, c]));
  const agents = MARKETPLACE_AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    tagline: a.tagline,
    category: a.category,
    capabilities: a.capabilities,
    priceUsdc: a.priceUsdc,
    etaSeconds: a.etaSeconds,
    reputation: creditById.get(a.id)?.score ?? 90,
  }));
  const etfs = MARKETPLACE_ETFS.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    agentIds: e.agentIds,
    bundlePriceUsdc: e.bundlePriceUsdc,
    etaSeconds: e.etaSeconds,
  }));
  return JSON.stringify({ agents, etfs }, null, 2);
}

const SYSTEM_PROMPT = `You are Butler's task router for an agent marketplace. Given a user task, pick the best execution route.

Rules:
- Prefer a bundled ETF workflow when the task clearly matches a pre-built multi-agent workflow (cheaper + coordinated).
- Use "direct" for a single specialist agent when one agent is enough.
- Use "workflow" when the task needs 2–3 agents but not a full ETF — e.g. "headlines and price" → news-agent + market-agent (NOT the full NVIDIA ETF unless they ask for a report or analysis).
- For deep research, papers, analysis, or investment research (not just headlines), use research-agent alone or an ETF that includes research-agent + report-agent.
- news-agent returns headlines only; research-agent returns full research briefs with executive summary, papers, and findings.
- For security audits, Solidity, or smart-contract review, always use audit-agent (direct) unless bill-audit-bundle ETF is explicitly about bills/subscriptions.
- defi-agent for yields/TVL/protocol analysis; macro-agent for Fed/CPI/rates; onchain-agent for whale/flow narratives; competitor-agent for moats; risk-agent for portfolio risk; bill-agent and subscription-agent for utility/recurring spend.
- ETF picks: btc-full-thesis-etf for comprehensive BTC investment theses (~1 min, single thesis agent); btc-onchain-etf for lighter BTC on-chain; defi-alpha-etf for DeFi; macro-radar-etf for macro; bill-audit-bundle for bills/subscriptions.
- Prefer btc-full-thesis-etf when the user asks for bull/base/bear scenarios, whale flows, DeFi exposure, and executive report on BTC.
- For comprehensive investment reports on a stock/company, prefer an ETF that includes research-agent + report-agent.
- Only use agent and ETF ids from the catalog. Never invent ids.
- Optimize for task fit, then reputation, then total cost.

Respond with JSON only:
{
  "strategy": "etf" | "workflow" | "direct",
  "etfId": string | null,
  "agentIds": string[],
  "reason": "One or two sentences explaining why this route fits the task."
}`;

export function getOpenAiPlannerStatus(): OpenAiPlannerStatus {
  const key = process.env.OPENAI_API_KEY?.trim();
  return {
    enabled: !!key,
    model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
  };
}

function parseLlmJson(content: string): LlmRouteResponse | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(raw) as LlmRouteResponse;
  } catch {
    return null;
  }
}

export async function planTaskWithOpenAi(
  task: string,
  credits: AgentCreditScore[] = []
): Promise<TaskPlan | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;

  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 25_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${SYSTEM_PROMPT}\n\nCatalog:\n${catalogForPrompt(credits)}` },
          { role: "user", content: task },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn("[openai-planner] API error", res.status, errText.slice(0, 200));
      return null;
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = parseLlmJson(content);
    if (!parsed?.strategy || !Array.isArray(parsed.agentIds)) return null;

    const plan = buildTaskPlanFromRoute({
      strategy: parsed.strategy,
      agentIds: parsed.agentIds,
      etfId: parsed.etfId ?? null,
      reason: parsed.reason ?? "AI-selected marketplace route.",
      router: "openai",
    });

    if (!plan) {
      console.warn("[openai-planner] invalid route from model", parsed);
    }
    return plan;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[openai-planner] failed:", msg);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
