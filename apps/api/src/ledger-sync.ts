import {
  appendRecord,
  getMarketplaceAgent,
  loadMarketplaceState,
  loadState,
  mergeAuctionUpdates,
  mergeJobUpdates,
  saveState,
  type MarketplaceJob,
  type MarketplaceState,
  type ReverseAuction,
  type SpendRecord,
} from "@butler/core";
import { enrichSpendPayer, resolveJobStepPayer } from "./ledger-payer.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function settlementFromStep(step: MarketplaceJob["steps"][number]): string | undefined {
  if (step.settlementId?.trim()) return step.settlementId.trim();
  const output = asRecord(step.output);
  if (!output) return undefined;
  const response = asRecord(output.response);
  const fromResponse =
    typeof response?.settlementId === "string"
      ? response.settlementId
      : typeof response?.transaction === "string"
        ? response.transaction
        : undefined;
  if (fromResponse?.trim()) return fromResponse.trim();
  const payment = asRecord(output.payment);
  if (typeof payment?.transaction === "string" && payment.transaction.trim()) {
    return payment.transaction.trim();
  }
  return undefined;
}

function payerFromStep(step: MarketplaceJob["steps"][number], job: MarketplaceJob): string | undefined {
  const output = asRecord(step.output);
  const response = output ? asRecord(output.response) : null;
  if (typeof response?.paid_by === "string" && response.paid_by.trim()) return response.paid_by.trim();
  if (typeof output?.paid_by === "string" && output.paid_by.trim()) return output.paid_by.trim();
  if (job.payerAddress?.trim()) return job.payerAddress.trim();
  return undefined;
}

function spendCategory(agent: { policyAgent: string }): SpendRecord["category"] {
  if (agent.policyAgent === "bills") return "bills";
  if (agent.policyAgent === "broker") return "services";
  return "apis";
}

function stepTimestamp(job: MarketplaceJob, stepIndex: number): number {
  return job.at + stepIndex;
}

/**
 * Lite API stores jobs inside butler-state.json; full mode uses marketplace-state.json.
 * Merge both so Activity always sees completed settlements.
 */
export function resolveMarketplaceForLedger(
  statePath: string,
  marketplacePath: string | undefined,
  sellerAddress: `0x${string}`
): Pick<MarketplaceState, "jobs" | "auctions"> {
  const primary = loadMarketplaceState(statePath, sellerAddress);
  if (!marketplacePath || marketplacePath === statePath) {
    return { jobs: primary.jobs, auctions: primary.auctions };
  }
  const secondary = loadMarketplaceState(marketplacePath, sellerAddress);
  if (secondary.jobs.length === 0 && secondary.auctions.length === 0) {
    return { jobs: primary.jobs, auctions: primary.auctions };
  }
  if (primary.jobs.length === 0 && primary.auctions.length === 0) {
    return { jobs: secondary.jobs, auctions: secondary.auctions };
  }
  return {
    jobs: mergeJobUpdates(secondary.jobs, primary.jobs),
    auctions: mergeAuctionUpdates(secondary.auctions, primary.auctions),
  };
}

/** Backfill ledger rows from completed marketplace job steps (Circle CLI pays sometimes skip appendRecord). */
export function mergeJobSettlementsIntoRecords(
  records: SpendRecord[],
  jobs: MarketplaceJob[],
  _auctions: ReverseAuction[] = []
): { records: SpendRecord[]; added: number } {
  const knownSettlements = new Set(
    records.map((r) => r.settlementId).filter((id): id is string => !!id?.trim())
  );
  const additions: SpendRecord[] = [];

  for (const job of jobs) {
    if (job.status !== "completed") continue;
    job.steps.forEach((step, index) => {
      const settlementId = settlementFromStep(step);
      if (!settlementId || knownSettlements.has(settlementId)) return;

      const agent = getMarketplaceAgent(step.agentId);
      if (!agent) return;
      if (step.status !== "done" && step.status !== "paid") return;

      const payerMeta = resolveJobStepPayer(payerFromStep(step, job), job.payerAddress);
      additions.push({
        id: `job-${job.id}-${step.agentId}-${index}`,
        at: stepTimestamp(job, index),
        agent: agent.policyAgent,
        category: spendCategory(agent),
        merchantId: agent.merchantId,
        amountUsdc: step.priceUsdc || agent.priceUsdc,
        settlementId,
        payerAddress: payerMeta.payerAddress,
        executorAddress: payerMeta.executorAddress,
        initiator: job.ownerSessionId || job.brief ? "user" : "system",
        status: "settled",
      });
      knownSettlements.add(settlementId);
    });
  }

  if (additions.length === 0) return { records, added: 0 };
  return { records: [...records, ...additions], added: additions.length };
}

export function syncLedgerFromJobs(
  statePath: string,
  sellerAddress: `0x${string}`,
  jobs: MarketplaceJob[],
  auctions: ReverseAuction[] = [],
  baseRecords?: SpendRecord[]
): SpendRecord[] {
  const prior = baseRecords ?? loadState(statePath, sellerAddress).records;
  const { records, added } = mergeJobSettlementsIntoRecords(prior, jobs, auctions);
  if (added > 0) {
    console.log(`[ledger] materialized ${added} payment(s) from ${jobs.length} jobs (read-only backfill)`);
  }
  return records;
}

export function appendLedgerFromOrchestration(params: {
  policyStatePath: string;
  sellerAddress: `0x${string}`;
  job: MarketplaceJob;
  agentId: string;
  settlementId?: string;
  amountUsdc: string;
  output?: unknown;
  payerAddress?: string;
}): void {
  const settlementId = params.settlementId?.trim();
  if (!settlementId) return;

  const agent = getMarketplaceAgent(params.agentId);
  if (!agent) return;

  const state = loadState(params.policyStatePath, params.sellerAddress);
  if (state.records.some((r) => r.settlementId === settlementId)) return;

  const payerMeta = enrichSpendPayer(params.payerAddress);
  const record: SpendRecord = {
    id: crypto.randomUUID(),
    at: Math.floor(Date.now() / 1000),
    agent: agent.policyAgent,
    category: spendCategory(agent),
    merchantId: agent.merchantId,
    amountUsdc: params.amountUsdc,
    settlementId,
    payerAddress: payerMeta.payerAddress,
    executorAddress: payerMeta.executorAddress,
    initiator: params.job.ownerSessionId || params.job.brief ? "user" : "system",
    status: "settled",
  };
  saveState(appendRecord(state, record), params.policyStatePath);
}
