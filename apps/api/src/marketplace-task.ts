import {
  getMarketplaceAgent,
  getMarketplaceEtf,
  patchMarketplaceState,
  planTaskExecution,
  recordAgentSuccess,
  resolveExpressBrief,
  treasuryCredit,
  type AgentCreditScore,
  type MarketplaceJob,
  type TaskPlan,
} from "@butler/core";
import { buildEtfJob, buildWorkflowJob, buildDirectJob, runMarketplaceWorkflow, type OrchestratorResult } from "./marketplace-orchestrator.ts";
import { planTaskWithOpenAi } from "./openai-planner.ts";

export async function planTaskForRun(params: {
  task: string;
  mode: "auto" | "manual";
  agentIds?: string[];
  etfId?: string | null;
  credits?: AgentCreditScore[];
  qualityTier?: string;
  auctionMode?: string;
  category?: string;
}): Promise<TaskPlan> {
  if (params.mode === "manual") {
    return planTaskExecution(params);
  }

  const aiPlan = await planTaskWithOpenAi(params.task, params.credits ?? [], {
    qualityTier: params.qualityTier,
    auctionMode: params.auctionMode,
    category: params.category,
  });
  if (aiPlan) return aiPlan;

  return { ...planTaskExecution(params), router: "heuristic" };
}

export function formatTaskResult(result: unknown): string {
  if (result == null) return "Task completed. No structured output was returned.";
  if (typeof result === "string") return result;

  const obj = unwrapAgentPayload(result);
  if (!obj) return JSON.stringify(result, null, 2);

  if (obj.report && typeof obj.report === "object") {
    const r = obj.report as Record<string, unknown>;
    const scenarios = Array.isArray(r.scenarios)
      ? (r.scenarios as Record<string, unknown>[])
          .map((s) => `• ${s.name ?? "Scenario"} (${s.probability ?? "?"}): ${s.description ?? ""}${s.priceTarget ? ` → ${s.priceTarget}` : ""}`)
          .join("\n")
      : null;
    const lines = [
      typeof r.title === "string" ? r.title : "Report",
      typeof r.rating === "string" ? `Rating: ${r.rating}` : null,
      typeof r.target === "string" ? `Target: ${r.target}` : null,
      typeof r.executiveSummary === "string" ? `\n${r.executiveSummary}` : typeof r.summary === "string" ? `\n${r.summary}` : null,
      scenarios ? `\nScenarios\n${scenarios}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

  if (obj.type === "investment-thesis") {
    const m = obj.liveMarket as Record<string, unknown> | undefined;
    const t = obj.technicals as Record<string, unknown> | undefined;
    const o = obj.onchain as Record<string, unknown> | undefined;
    const d = obj.defi as Record<string, unknown> | undefined;
    const r = obj.report as Record<string, unknown> | undefined;
    const lines = [
      typeof r?.title === "string" ? r.title : `${obj.symbol ?? "BTC"} Investment Thesis`,
      m?.price != null ? `\nLive: $${m.price} (${m.change24h ?? "?"}% 24h)` : null,
      t ? `\nTechnicals: support ${t.support}, resistance ${t.resistance}, RSI ${t.rsi}` : null,
      o?.whaleActivity ? `\nWhales: ${o.whaleActivity}` : null,
      o?.exchangeFlows ? `Exchange flows: ${o.exchangeFlows}` : null,
      d?.summary ? `\nDeFi: ${d.summary}` : null,
      Array.isArray(obj.risks) ? `\nRisks\n${(obj.risks as string[]).map((x) => `• ${x}`).join("\n")}` : null,
      typeof r?.executiveSummary === "string" ? `\n${r.executiveSummary}` : null,
      Array.isArray(r?.scenarios)
        ? `\nScenarios\n${(r.scenarios as Record<string, unknown>[]).map((s) => `• ${s.name}: ${s.description}`).join("\n")}`
        : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

  if (Array.isArray(obj.headlines)) {
    const lines = obj.headlines.map((h) => {
      const row = h as Record<string, unknown>;
      const impact = typeof row.traderImpact === "string" ? `\n  Why it matters: ${row.traderImpact}` : "";
      const url = typeof row.url === "string" ? `\n  ${row.url}` : "";
      return `- ${row.title ?? "Headline"} (${row.source ?? "source"})${impact}${url}`;
    });
    return `Headlines for ${String(obj.topic ?? obj.ticker ?? "crypto")}:\n${lines.join("\n\n")}`;
  }

  if (typeof obj.symbol === "string" && obj.price != null) {
    return `${obj.symbol}: $${obj.price} (${obj.change24h ?? "?"}% 24h, vol ${obj.volume ?? "—"})`;
  }

  if (typeof obj.score === "number" && typeof obj.label === "string") {
    return `Sentiment: ${obj.label} (score ${obj.score}, ${obj.sources ?? "?"} sources)`;
  }

  if (typeof obj.contract === "string" || obj.type === "audit" || Array.isArray(obj.findings)) {
    const findings = (obj.findings as Record<string, unknown>[] | undefined)
      ?.map((f) => {
        const sev = f.severity ? `[${String(f.severity).toUpperCase()}] ` : "";
        const title = f.title ? String(f.title) : "Finding";
        const detail = f.detail ? `: ${String(f.detail)}` : "";
        return `- ${sev}${title}${detail}`;
      })
      .join("\n");
    return [
      `Security audit: ${obj.contract ?? "contract"}`,
      typeof obj.summary === "string" ? obj.summary : null,
      findings ? `\nFindings\n${findings}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (Array.isArray(obj.papers) && (obj.type === "research" || typeof obj.executiveSummary === "string")) {
    const lines = [
      `Research: ${obj.focus ?? "topic"}`,
      typeof obj.executiveSummary === "string" ? `\nExecutive summary\n${obj.executiveSummary}` : null,
      Array.isArray(obj.keyFindings)
        ? `\nKey findings\n${(obj.keyFindings as string[]).map((f) => `• ${f}`).join("\n")}`
        : null,
      `\nSources reviewed (${(obj.papers as unknown[]).length})`,
      ...(obj.papers as Record<string, unknown>[]).map((p) => {
        const abs = typeof p.abstract === "string" ? `\n  ${p.abstract}` : "";
        return `- ${p.title ?? "Paper"}${p.authors ? ` (${p.authors}` : ""}${p.year ? `, ${p.year})` : p.authors ? ")" : ""}${abs}`;
      }),
      Array.isArray(obj.limitations)
        ? `\nLimitations\n${(obj.limitations as string[]).map((l) => `• ${l}`).join("\n")}`
        : null,
      Array.isArray(obj.risks) ? `\nRisks\n${(obj.risks as string[]).map((r) => `• ${r}`).join("\n")}` : null,
      typeof obj.methodology === "string" ? `\nMethodology: ${obj.methodology}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

  if (typeof obj.provider === "string" && obj.amountDue != null) {
    const items = (obj.lineItems as { label: string; amount: number }[] | undefined)
      ?.map((i) => `- ${i.label}: $${i.amount}`)
      .join("\n");
    return [`Utility quote: ${obj.provider} — $${obj.amountDue} due ${obj.dueDate ?? "—"}`, items, obj.notes].filter(Boolean).join("\n");
  }

  if (Array.isArray(obj.papers)) {
    const papers = (obj.papers as Record<string, unknown>[]).map((p) => `- ${p.title ?? "Paper"}`).join("\n");
    return `Research${obj.focus ? ` (${obj.focus})` : ""}:\n${papers}`;
  }

  if (typeof obj.pattern === "string" && obj.type === "technical-analysis") {
    const lines = [
      `${obj.symbol ?? "Asset"} Technical Analysis`,
      obj.price != null ? `\nPrice: $${obj.price} (${obj.change24h ?? "?"}% 24h)` : null,
      obj.bias ? `Bias: ${obj.bias}` : null,
      obj.support != null ? `Support: $${obj.support}` : null,
      obj.resistance != null ? `Resistance: $${obj.resistance}` : null,
      obj.rsi != null ? `RSI: ${obj.rsi}` : null,
      obj.pattern ? `Pattern: ${obj.pattern}` : null,
      typeof obj.summary === "string" ? `\n${obj.summary}` : null,
      Array.isArray(obj.keyLevels) ? `\nKey levels\n${(obj.keyLevels as string[]).map((l) => `• ${l}`).join("\n")}` : null,
      Array.isArray(obj.catalysts) ? `\nCatalysts\n${(obj.catalysts as string[]).map((c) => `• ${c}`).join("\n")}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

  if (typeof obj.pattern === "string") {
    return `Chart: ${obj.pattern}, support ${obj.support}, resistance ${obj.resistance}, RSI ${obj.rsi}`;
  }

  if (obj.type === "defi" || Array.isArray(obj.topProtocols)) {
    const protocols = (obj.topProtocols as Record<string, unknown>[] | undefined)
      ?.map((p) => `- ${p.name ?? "Protocol"} (${p.chain ?? "?"}) TVL ${p.tvlUsd ?? "?"} · APY ${p.yieldApy ?? "?"}`)
      .join("\n");
    return [
      `DeFi: ${obj.focus ?? "overview"}`,
      typeof obj.tvlTrend === "string" ? obj.tvlTrend : null,
      protocols ? `\nTop protocols\n${protocols}` : null,
      typeof obj.summary === "string" ? `\n${obj.summary}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (obj.type === "macro" || typeof obj.fedOutlook === "string") {
    const indicators = (obj.keyIndicators as Record<string, unknown>[] | undefined)
      ?.map((i) => `- ${i.name}: ${i.value} — ${i.implication}`)
      .join("\n");
    return [
      `Macro: ${obj.focus ?? "outlook"} (${obj.regime ?? "mixed"})`,
      indicators ? `\nIndicators\n${indicators}` : null,
      typeof obj.fedOutlook === "string" ? `\nFed: ${obj.fedOutlook}` : null,
      typeof obj.summary === "string" ? `\n${obj.summary}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (obj.type === "onchain" || Array.isArray(obj.signals)) {
    const signals = (obj.signals as Record<string, unknown>[] | undefined)
      ?.map((s) => `- ${s.label} (${s.direction}): ${s.detail}`)
      .join("\n");
    return [
      `On-chain: ${obj.asset ?? "asset"}`,
      typeof obj.exchangeFlows === "string" ? `\nExchange flows: ${obj.exchangeFlows}` : null,
      typeof obj.whaleActivity === "string" ? `\nWhales: ${obj.whaleActivity}` : null,
      typeof obj.networkActivity === "string" ? obj.networkActivity : null,
      typeof obj.outlook7d === "string" ? `\n7-day outlook: ${obj.outlook7d}` : null,
      signals ? `\nSignals\n${signals}` : null,
      typeof obj.summary === "string" ? `\n${obj.summary}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (obj.type === "competitor" || Array.isArray(obj.competitors)) {
    const rows = (obj.competitors as Record<string, unknown>[] | undefined)
      ?.map((c) => `- ${c.name}: moat ${c.moat}; weakness ${c.weakness}`)
      .join("\n");
    return [`Competitive landscape: ${obj.subject ?? "subject"}`, rows, typeof obj.summary === "string" ? obj.summary : null]
      .filter(Boolean)
      .join("\n\n");
  }

  if (obj.type === "risk" || typeof obj.riskScore === "number") {
    const factors = (obj.factors as Record<string, unknown>[] | undefined)
      ?.map((f) => `- [${f.severity}] ${f.name}: ${f.note}`)
      .join("\n");
    return [
      `Risk: ${obj.riskLabel ?? "—"} (score ${obj.riskScore ?? "?"})`,
      factors ? `\nFactors\n${factors}` : null,
      typeof obj.summary === "string" ? `\n${obj.summary}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (typeof obj.provider === "string" && obj.amountDue != null) {
    const items = (obj.lineItems as { label: string; amount: number }[] | undefined)
      ?.map((i) => `- ${i.label}: $${i.amount}`)
      .join("\n");
    return [`Utility quote: ${obj.provider} — $${obj.amountDue} due ${obj.dueDate ?? "—"}`, items, obj.notes].filter(Boolean).join("\n");
  }

  if (Array.isArray(obj.subscriptions)) {
    const subs = (obj.subscriptions as Record<string, unknown>[]).map((s) => `- ${s.name}: $${s.amount}/mo`).join("\n");
    return `Subscriptions ($${obj.monthlyTotal ?? "?"} / mo):\n${subs}`;
  }

  return JSON.stringify(result, null, 2);
}

function unwrapAgentPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const response = obj.response;
  if (response && typeof response === "object") {
    const inner = response as Record<string, unknown>;
    if (inner.data && typeof inner.data === "object") return inner.data as Record<string, unknown>;
    return inner;
  }
  if (obj.data && typeof obj.data === "object") return obj.data as Record<string, unknown>;
  return obj;
}

function formatStepOutput(raw: unknown): string | null {
  const obj = unwrapAgentPayload(raw);
  if (!obj) return null;
  return formatTaskResult(obj);
}

export function formatWorkflowSummary(steps: { output?: unknown }[]): string {
  const parts = steps.map((s) => formatStepOutput(s.output)).filter((p): p is string => !!p && p.length > 0);
  if (parts.length === 0) return "Task completed. No structured output was returned.";
  if (parts.length === 1) return parts[0]!;
  return parts.join("\n\n");
}

import { combineWorkflowResult } from "./deliverable-combine.ts";

export function inferPlanFromJob(job: MarketplaceJob): MarketplaceJob["plan"] {
  const agentIds = job.steps.map((s) => s.agentId);
  const brief = job.brief ?? "";

  if (job.etfId) {
    const etf = getMarketplaceEtf(job.etfId);
    return {
      strategy: "etf",
      agentIds,
      etfId: job.etfId,
      reason:
        etf?.id === "deep-dive-etf"
          ? "Deep Dive — all specialists contributed one unified research document."
          : etf
            ? `${etf.name} — multi-agent workflow, single combined deliverable.`
            : "Multi-agent ETF workflow — combined deliverable.",
    };
  }
  if (job.type === "auction" && agentIds.length > 1) {
    return {
      strategy: "workflow",
      agentIds,
      reason: "Auction award — multi-agent workflow, single combined deliverable.",
    };
  }
  if (agentIds.length > 1) {
    return {
      strategy: "workflow",
      agentIds,
      reason: "Multi-agent workflow — combined deliverable.",
    };
  }

  const express = brief ? resolveExpressBrief(brief) : null;
  const agentId = agentIds[0] ?? job.targetAgentId;
  const agent = agentId ? getMarketplaceAgent(agentId) : undefined;

  if (express && agent) {
    return {
      strategy: "direct",
      agentIds: agentId ? [agentId] : [],
      reason: `${agent.name} — ${express.label}.`,
    };
  }

  return {
    strategy: "direct",
    agentIds: agentId ? [agentId] : [],
    reason: agent ? `${agent.name} — focused deliverable for this brief.` : "Single-agent deliverable.",
  };
}

export function finalizeCompletedJob(
  job: MarketplaceJob,
  orchestration: OrchestratorResult
): MarketplaceJob {
  const stepsResult = orchestration?.steps ?? [];
  const completed = stepsResult.length > 0 && stepsResult.every((s) => s?.ok);
  const steps = job.steps.map((step, i) => {
    const r = stepsResult[i];
    if (!r) return { ...step, status: "failed" as const };
    return {
      ...step,
      status: r?.ok ? ("done" as const) : ("failed" as const),
      settlementId: r.settlementId,
      output: r.output,
      error: r.error,
    };
  });

  const doneSteps = steps.filter((s) => s.status === "done" && s.output != null);
  const combined = combineWorkflowResult(doneSteps);
  const result = combined ?? orchestration.result;

  const finalized: MarketplaceJob = {
    ...job,
    status: completed ? "completed" : "failed",
    steps,
    result,
    totalUsdc: orchestration.totalUsdc || job.totalUsdc,
    plan: job.plan ?? inferPlanFromJob({ ...job, steps }),
  };
  finalized.summary = buildJobSummary(finalized);
  return finalized;
}

export function buildJobSummary(job: MarketplaceJob): string {
  if (job.summary?.trim()) return job.summary.trim();
  const doneSteps = job.steps.filter((s) => s.status === "done" && s.output != null);
  if (doneSteps.length > 1) {
    const combined = combineWorkflowResult(doneSteps);
    if (combined) return formatTaskResult(combined);
    return formatWorkflowSummary(doneSteps);
  }
  if (doneSteps.length === 1) return formatTaskResult(doneSteps[0]!.output);
  if (job.result != null) return formatTaskResult(job.result);
  return "No deliverable content available.";
}

export function planToJobPlan(plan: TaskPlan): MarketplaceJob["plan"] {
  return {
    strategy: plan.strategy,
    agentIds: plan.agentIds,
    etfId: plan.etfId,
    reason: plan.reason,
    router: plan.router,
  };
}

export function jobFromPlan(plan: TaskPlan, brief: string): MarketplaceJob | null {
  if (plan.strategy === "etf" && plan.etfId) {
    return buildEtfJob(plan.etfId, brief);
  }
  if (plan.strategy === "direct" && plan.agentIds[0]) {
    return buildDirectJob(plan.agentIds[0], brief);
  }
  return buildWorkflowJob(plan.agentIds, brief);
}

export async function runMarketplaceTask(params: {
  apiBase: string;
  task: string;
  mode: "auto" | "manual";
  agentIds?: string[];
  etfId?: string | null;
  forceX402?: boolean;
  credits?: AgentCreditScore[];
  statePath?: string;
  sellerAddress?: string;
}): Promise<{
  plan: TaskPlan;
  job: MarketplaceJob;
  orchestration: OrchestratorResult;
  summary: string;
}> {
  const plan = await planTaskForRun({
    task: params.task,
    mode: params.mode,
    agentIds: params.agentIds,
    etfId: params.etfId,
    credits: params.credits,
  });
  const job = jobFromPlan(plan, params.task);
  if (!job) {
    throw new Error("Could not build job for this task.");
  }

  const orchestration = await runMarketplaceWorkflow({
    apiBase: params.apiBase,
    job,
    forceX402: params.forceX402,
    initiator: "user",
    statePath: params.statePath,
    policyStatePath: params.statePath,
    sellerAddress: params.sellerAddress,
  });

  const failed = (orchestration?.steps ?? []).find((s) => s && !s.ok);
  if (failed) {
    throw new Error(failed.error ?? `Payment failed at ${getMarketplaceAgent(failed.agentId)?.name ?? failed.agentId}`);
  }

  const finalized = finalizeCompletedJob({ ...job, plan: planToJobPlan(plan) }, orchestration);
  const summary = finalized.summary ?? buildJobSummary(finalized);

  if (params.statePath && params.sellerAddress) {
    patchMarketplaceState(params.statePath, params.sellerAddress, (latest) => {
      let stats = latest.agentStats;
      let treasury = latest.treasury;
      for (const step of orchestration.steps ?? []) {
        if (!step?.ok) continue;
        const agent = getMarketplaceAgent(step.agentId);
        if (!agent) continue;
        const row = recordAgentSuccess({ ...latest, agentStats: stats, treasury }, step.agentId, agent.priceUsdc, agent.etaSeconds);
        stats = row.agentStats;
        treasury = treasuryCredit(row, agent.priceUsdc).treasury;
      }
      return { jobs: [finalized], agentStats: stats, treasury };
    });
  }

  return { plan, job: finalized, orchestration, summary };
}
