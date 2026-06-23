import {
  getMarketplaceAgent,
  getMarketplaceEtf,
  listMarketplaceAgents,
  resolveAgentServiceUrl,
  isExternalAgent,
  type MarketplaceJob,
  type MarketplaceJobStep,
  type SpendInitiator,
} from "@butler/core";
import { circleCliLoggedIn, circleGatewayBalanceUsdc, circleServicesPay, ensureCircleExecutor } from "./circle-cli.ts";
import { resolveCircleExecutorAddress } from "./circle-config.ts";
import { formatPaymentError } from "./payment-errors.ts";
import { validateExternalAgent } from "./external-agent-registry.ts";
import { appendServiceUrlParams } from "./x402-probe.ts";
import { combineWorkflowResult } from "./deliverable-combine.ts";
import { stashWorkflowContext } from "./context-store.ts";
import { GatewayClient } from "@circle-fin/x402-batching/client";

function snippetFromStepBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const row = body as Record<string, unknown>;
  const data = (row.data ?? row) as Record<string, unknown>;
  if (typeof data.summary === "string" && data.summary.length > 20) return data.summary;
  if (data.report && typeof data.report === "object") {
    const r = data.report as Record<string, unknown>;
    return [r.title, r.rating, r.summary, r.executiveSummary].filter((x) => typeof x === "string").join(" — ");
  }
  if (typeof data.executiveSummary === "string") return data.executiveSummary;
  if (typeof data.focus === "string" && data.type) return `${data.type}: ${data.focus}`;
  return JSON.stringify(data).slice(0, 600);
}

export interface OrchestratorStepResult {
  agentId: string;
  ok: boolean;
  status: number;
  settlementId?: string;
  output?: unknown;
  error?: string;
}

export interface OrchestratorResult {
  jobId: string;
  steps: OrchestratorStepResult[];
  totalUsdc: string;
  mode: "x402" | "circle-cli";
  result?: unknown;
}

async function payAndFetch(
  payUrl: string,
  options: { dryRun?: boolean; forceX402?: boolean }
): Promise<{ ok: boolean; status: number; body?: unknown; error?: string }> {
  try {
  const url = payUrl;
  if (options.dryRun) {
    return { ok: false, status: 400, error: "dryRun is disabled — all workflows execute real x402 payments" };
  }

  const pk = process.env.BUTLER_EXECUTOR_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  const circleAddr = ensureCircleExecutor() ?? resolveCircleExecutorAddress();
  const useCircle =
    !options.forceX402 &&
    (process.env.BUTLER_USE_CIRCLE_CLI === "true" || (circleCliLoggedIn() && !!circleAddr));

  if (useCircle && circleAddr) {
    const balance = circleGatewayBalanceUsdc(circleAddr);
    if (balance === "0" || balance === "0.0" || balance === "0.00") {
      return {
        ok: false,
        status: 0,
        error:
          "Insufficient Gateway USDC. Fund your payer wallet at faucet.circle.com (Arc testnet), then deposit to Gateway.",
      };
    }
    const pay = await circleServicesPay({ url, address: circleAddr });
    if (!pay?.ok) {
      return { ok: false, status: 0, error: pay?.error ?? formatPaymentError(`${pay?.stderr ?? ""}\n${pay?.stdout ?? ""}`) };
    }
    try {
      const body = JSON.parse(pay.stdout || "{}");
      return { ok: true, status: 200, body };
    } catch {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    }
  }

  if (!pk || !pk.startsWith("0x") || pk.length < 66) {
    return { ok: false, status: 0, error: "Configure Circle login or BUTLER_EXECUTOR_PRIVATE_KEY" };
  }

  const client = new GatewayClient({ chain: "arcTestnet", privateKey: pk as `0x${string}` });
  const payResult = await client.pay(url);
  if (!payResult || typeof payResult !== "object") {
    return { ok: false, status: 0, error: "Gateway payment returned no result" };
  }
  const { status, data } = payResult;
  let body: unknown = data;
  if (typeof data === "string") {
    try {
      body = JSON.parse(data);
    } catch {
      body = { raw: data };
    }
  }
  return { ok: status >= 200 && status < 300, status, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment failed";
    return { ok: false, status: 0, error: formatPaymentError(message) };
  }
}

function assertAgentPayable(agent: ReturnType<typeof getMarketplaceAgent>): string | null {
  if (!agent) return "Unknown agent";
  if (isExternalAgent(agent)) {
    return validateExternalAgent(agent);
  }
  return null;
}

function splitParallelWorkflow(steps: MarketplaceJobStep[]): {
  parallel: MarketplaceJobStep[];
  tail: MarketplaceJobStep[];
} {
  const tailIdx = steps.findIndex((s) => s.agentId === "report-agent");
  if (tailIdx <= 0 || steps.length < 3) return { parallel: [], tail: steps };
  return { parallel: steps.slice(0, tailIdx), tail: steps.slice(tailIdx) };
}

async function runOneStep(params: {
  apiBase: string;
  job: MarketplaceJob;
  step: MarketplaceJobStep;
  priorContext: string;
  dryRun?: boolean;
  forceX402?: boolean;
  initiator?: SpendInitiator;
}): Promise<{ result: OrchestratorStepResult; micro: bigint; output?: unknown; snippet: string }> {
  const agent = getMarketplaceAgent(params.step.agentId);
  const policyErr = assertAgentPayable(agent);
  if (policyErr || !agent) {
    return {
      result: { agentId: params.step.agentId, ok: false, status: 0, error: policyErr ?? "Unknown agent" },
      micro: 0n,
      snippet: "",
    };
  }

  const [w, f = ""] = agent.priceUsdc.split(".");
  const micro = BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));

  const serviceUrl = resolveAgentServiceUrl(agent, params.apiBase);
  const payUrl = appendServiceUrlParams(serviceUrl, {
    brief: params.job.brief,
    initiator: params.initiator ?? "system",
    contextId: params.priorContext ? stashWorkflowContext(params.priorContext) : undefined,
  });

  let finalRes = await payAndFetch(payUrl, {
    dryRun: params.dryRun,
    forceX402: params.forceX402,
  });
  for (let attempt = 0; attempt < 1 && !finalRes?.ok && /timeout|aborted|rejected|endpoint/i.test(finalRes?.error ?? ""); attempt++) {
    await new Promise((r) => setTimeout(r, 1_500));
    finalRes = await payAndFetch(payUrl, {
      dryRun: params.dryRun,
      forceX402: params.forceX402,
    });
  }

  const body = finalRes?.body as Record<string, unknown> | undefined;
  const stepResult: OrchestratorStepResult = {
    agentId: params.step.agentId,
    ok: !!finalRes?.ok,
    status: finalRes?.status ?? 0,
    settlementId:
      typeof body?.settlementId === "string"
        ? body.settlementId
        : typeof body?.transaction === "string"
          ? body.transaction
          : undefined,
    output: body?.data ?? body,
    error: finalRes?.error ?? (finalRes?.ok ? undefined : `HTTP ${finalRes?.status ?? 0}`),
  };

  let snippet = "";
  let output: unknown;
  if (finalRes?.ok && body) {
    output = body?.data ?? body;
    snippet = snippetFromStepBody(body);
  }

  return { result: stepResult, micro, output, snippet };
}

export async function runMarketplaceWorkflow(params: {
  apiBase: string;
  job: MarketplaceJob;
  dryRun?: boolean;
  forceX402?: boolean;
  initiator?: SpendInitiator;
}): Promise<OrchestratorResult> {
  const steps: OrchestratorStepResult[] = [];
  let totalMicro = 0n;
  const outputs: unknown[] = [];
  let priorContext = "";

  const { parallel, tail } = splitParallelWorkflow(params.job.steps);
  const batches =
    parallel.length > 0 ? [parallel, ...tail.map((s) => [s])] : params.job.steps.map((s) => [s]);

  for (const batch of batches) {
    if (batch.length > 1) {
      const results = await Promise.all(
        batch.map((step) =>
          runOneStep({
            apiBase: params.apiBase,
            job: params.job,
            step,
            priorContext: "",
            dryRun: params.dryRun,
            forceX402: params.forceX402,
            initiator: params.initiator,
          })
        )
      );
      for (const row of results) {
        totalMicro += row.micro;
        steps.push(row.result);
        if (row.result.ok && row.output != null) {
          outputs.push(row.output);
          if (row.snippet) {
            priorContext = priorContext ? `${priorContext}\n\n---\n\n${row.snippet}` : row.snippet;
            priorContext = priorContext.slice(0, 4_000);
          }
        }
      }
      if (results.some((r) => !r.result.ok)) break;
      continue;
    }

    const step = batch[0]!;
    const row = await runOneStep({
      apiBase: params.apiBase,
      job: params.job,
      step,
      priorContext,
      dryRun: params.dryRun,
      forceX402: params.forceX402,
      initiator: params.initiator,
    });
    totalMicro += row.micro;
    steps.push(row.result);
    if (!row.result.ok) break;
    if (row.output != null) {
      outputs.push(row.output);
      if (row.snippet) {
        priorContext = priorContext ? `${priorContext}\n\n---\n\n${row.snippet}` : row.snippet;
        priorContext = priorContext.slice(0, 4_000);
      }
    }
  }

  const whole = totalMicro / 1_000_000n;
  const frac = totalMicro % 1_000_000n;
  const totalUsdc =
    frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;

  let result: unknown;
  const doneOutputs = steps.filter((s) => s.ok && s.output != null);
  if (doneOutputs.length > 1) {
    result = combineWorkflowResult(doneOutputs) ?? doneOutputs.at(-1)?.output;
  } else if (doneOutputs.length === 1) {
    result = doneOutputs[0]!.output;
  } else if (outputs.length > 1) {
    const last = outputs[outputs.length - 1] as Record<string, unknown>;
    result = last?.report ?? last;
  } else if (outputs.length === 1) {
    result = outputs[0];
  }

  return {
    jobId: params.job.id,
    steps,
    totalUsdc,
    mode: circleCliLoggedIn() ? "circle-cli" : "x402",
    result,
  };
}

export function buildJobSteps(agentIds: string[]): MarketplaceJobStep[] {
  return agentIds.map((id) => {
    const agent = listMarketplaceAgents().find((a) => a.id === id);
    return {
      agentId: id,
      label: agent?.name ?? id,
      priceUsdc: agent?.priceUsdc ?? "0",
      status: "pending" as const,
    };
  });
}

export function buildEtfJob(etfId: string, brief?: string): MarketplaceJob | null {
  const etf = getMarketplaceEtf(etfId);
  if (!etf) return null;
  return {
    id: crypto.randomUUID(),
    at: Math.floor(Date.now() / 1000),
    type: "etf",
    status: "pending",
    etfId,
    brief,
    totalUsdc: etf.bundlePriceUsdc,
    steps: buildJobSteps(etf.agentIds),
  };
}

export function buildDirectJob(agentId: string, brief?: string): MarketplaceJob | null {
  const agent = getMarketplaceAgent(agentId);
  if (!agent) return null;
  return {
    id: crypto.randomUUID(),
    at: Math.floor(Date.now() / 1000),
    type: "direct",
    status: "pending",
    targetAgentId: agentId,
    brief,
    totalUsdc: agent.priceUsdc,
    steps: buildJobSteps([agentId]),
  };
}

export function buildWorkflowJob(agentIds: string[], brief?: string): MarketplaceJob | null {
  const ids = agentIds.filter((id) => !!getMarketplaceAgent(id));
  if (ids.length === 0) return null;
  const steps = buildJobSteps(ids);
  let micro = 0n;
  for (const step of steps) {
    const [w, f = ""] = step.priceUsdc.split(".");
    micro += BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  }
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  const totalUsdc =
    frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  return {
    id: crypto.randomUUID(),
    at: Math.floor(Date.now() / 1000),
    type: "etf",
    status: "pending",
    brief,
    totalUsdc,
    steps,
  };
}
