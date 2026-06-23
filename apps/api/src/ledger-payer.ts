import { privateKeyToAccount } from "viem/accounts";
import { getMarketplaceAgent, type MarketplaceJob, type ReverseAuction, type SpendRecord, type SpendInitiator } from "@butler/core";
import { loadCircleConfig, resolveCircleExecutorAddress, saveCircleConfig } from "./circle-config.ts";

export function getExecutorWalletAddress(): `0x${string}` | null {
  const fromCircle = resolveCircleExecutorAddress();
  if (fromCircle) return fromCircle;
  const fromEnv = process.env.CIRCLE_EXECUTOR_ADDRESS;
  if (fromEnv?.startsWith("0x")) return fromEnv as `0x${string}`;
  const pk = process.env.BUTLER_EXECUTOR_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!pk?.startsWith("0x") || pk.length < 66) return null;
  try {
    return privateKeyToAccount(pk as `0x${string}`).address;
  } catch {
    return null;
  }
}

function persistGatewayPayer(gatewayPayer: string): void {
  const normalized = gatewayPayer.toLowerCase();
  const cfg = loadCircleConfig();
  if (cfg.gatewayPayerAddress?.toLowerCase() === normalized) return;
  const executor = cfg.executorAddress?.toLowerCase();
  if (executor && executor === normalized) return;
  saveCircleConfig({ gatewayPayerAddress: gatewayPayer as `0x${string}` });
}

export function parseSpendInitiator(value: unknown): SpendInitiator | undefined {
  if (value === "user" || value === "system" || value === "cli") return value;
  return undefined;
}

export function spendInitiatorFromQuery(query: Record<string, unknown>): SpendInitiator {
  const raw = query.butler_initiator ?? query.initiator;
  return parseSpendInitiator(typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined) ?? "system";
}

/** Marketplace agent x402 routes are user-facing — default to user when Circle CLI omits query params. */
export function spendInitiatorFromMarketplaceQuery(query: Record<string, unknown>): SpendInitiator {
  const raw = query.butler_initiator ?? query.initiator;
  return parseSpendInitiator(typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined) ?? "user";
}

function amountMatches(a: string, b: string): boolean {
  return Math.abs(Number(a) - Number(b)) < 0.000001;
}

/** Match ledger rows to completed Agent / Marketplace jobs (historical backfill). */
export function inferUserRecordIdsFromJobs(
  records: SpendRecord[],
  jobs: MarketplaceJob[],
  auctions: ReverseAuction[] = []
): Set<string> {
  const auctionMap = new Map(auctions.map((a) => [a.id, a]));
  const used = new Set<string>();
  const userIds = new Set<string>();

  const eligible = jobs
    .filter((j) => {
      if (j.status !== "completed") return false;
      if (!j.auctionId) return true;
      const auction = auctionMap.get(j.auctionId);
      return auction?.payerAgentOwned !== false;
    })
    .sort((a, b) => a.at - b.at);

  for (const job of eligible) {
    let cursor = job.at;
    for (const step of job.steps) {
      if (step.status !== "done" && step.status !== "paid") continue;

      const agent = getMarketplaceAgent(step.agentId);
      if (!agent) continue;

      if (step.settlementId) {
        const bySettlement = records.find(
          (r) => r.settlementId === step.settlementId && !used.has(r.id)
        );
        if (bySettlement) {
          userIds.add(bySettlement.id);
          used.add(bySettlement.id);
          cursor = bySettlement.at;
          continue;
        }
      }

      const candidates = records
        .filter(
          (r) =>
            !used.has(r.id) &&
            r.merchantId === agent.merchantId &&
            r.status === "settled" &&
            amountMatches(r.amountUsdc, agent.priceUsdc) &&
            r.at >= job.at - 60 &&
            r.at <= cursor + agent.etaSeconds + 180
        )
        .sort((a, b) => Math.abs(a.at - cursor) - Math.abs(b.at - cursor));

      const match = candidates[0];
      if (!match) continue;
      userIds.add(match.id);
      used.add(match.id);
      cursor = match.at;
    }
  }

  return userIds;
}

export function applyJobAttribution(
  records: SpendRecord[],
  jobs: MarketplaceJob[],
  auctions: ReverseAuction[] = []
): SpendRecord[] {
  const userIds = inferUserRecordIdsFromJobs(records, jobs, auctions);
  if (userIds.size === 0) return records;
  return records.map((r) =>
    r.initiator === "user" || userIds.has(r.id) ? { ...r, initiator: "user" as const } : r
  );
}

export function enrichSpendPayer(paymentPayer?: string | null): {
  payerAddress?: string;
  executorAddress?: string;
} {
  const executor = getExecutorWalletAddress();
  const gateway = paymentPayer?.trim();
  if (gateway) persistGatewayPayer(gateway);
  return {
    payerAddress: gateway || executor || undefined,
    executorAddress: executor || undefined,
  };
}

/** Learn Gateway smart-account payer from historical ledger rows (one-time per install). */
export function inferGatewayPayerFromLedger(records: SpendRecord[]): void {
  const cfg = loadCircleConfig();
  if (cfg.gatewayPayerAddress || !cfg.executorAddress) return;
  const executor = cfg.executorAddress.toLowerCase();
  const counts = new Map<string, number>();
  for (const r of records) {
    const p = r.payerAddress?.toLowerCase();
    if (!p || p === executor) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top?.[0]) persistGatewayPayer(top[0]);
}

/** Addresses that belong to the logged-in / configured payer (wallet + Gateway account). */
export function resolveActivityPayerAddresses(records?: SpendRecord[]): string[] {
  inferGatewayPayerFromLedger(records ?? []);
  const set = new Set<string>();
  const executor = getExecutorWalletAddress();
  if (executor) set.add(executor.toLowerCase());
  const cfg = loadCircleConfig();
  if (cfg.gatewayPayerAddress) set.add(cfg.gatewayPayerAddress.toLowerCase());
  return [...set];
}

/** Backfill payer fields on legacy rows once Gateway payer is known. */
export function attributeLedgerRecords(records: SpendRecord[]): SpendRecord[] {
  inferGatewayPayerFromLedger(records);
  const executor = getExecutorWalletAddress();
  const gateway = loadCircleConfig().gatewayPayerAddress;
  if (!executor && !gateway) return records;
  return records.map((r) => {
    if (r.payerAddress || r.executorAddress) return r;
    return {
      ...r,
      payerAddress: gateway ?? executor ?? undefined,
      executorAddress: executor ?? undefined,
    };
  });
}

export function filterMineRecords(records: SpendRecord[], payerAddresses: string[]): SpendRecord[] {
  if (payerAddresses.length === 0) return [];
  const mine = new Set(payerAddresses.map((a) => a.toLowerCase()));
  return records.filter((r) => {
    if (r.initiator !== "user") return false;
    const payer = r.payerAddress?.toLowerCase();
    const executor = r.executorAddress?.toLowerCase();
    return (payer && mine.has(payer)) || (executor && mine.has(executor));
  });
}
