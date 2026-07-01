import type { Request, Response } from "express";
import { loadState, remainingDailyUsdc, type SpendRecord } from "@butler/core";
import {
  applyJobAttribution,
  attributeLedgerRecords,
  filterLedgerForOwnerScope,
  filterRecordsForOwner,
  resolveSessionActivityPayerAddresses,
} from "./ledger-payer.ts";
import { resolveMarketplaceForLedger, syncLedgerFromJobs } from "./ledger-sync.ts";
import { resolveJobOwnerFromRequest, resolveOwnerPayerAddresses } from "./job-owner.ts";
import { LEDGER_BACKFILL_VERSION } from "./route-loader-status.ts";

const JOBS_CACHE_MS = 15_000;
let jobsCache: {
  at: number;
  statePath: string;
  jobs: import("@butler/core").MarketplaceJob[];
  auctions: import("@butler/core").ReverseAuction[];
} | null = null;

function jobsForLedger(
  statePath: string,
  marketplacePath: string | undefined,
  sellerAddress: `0x${string}`
) {
  if (
    jobsCache &&
    jobsCache.statePath === statePath &&
    Date.now() - jobsCache.at < JOBS_CACHE_MS
  ) {
    return { jobs: jobsCache.jobs, auctions: jobsCache.auctions };
  }
  const loaded = resolveMarketplaceForLedger(statePath, marketplacePath, sellerAddress);
  jobsCache = { at: Date.now(), statePath, jobs: loaded.jobs, auctions: loaded.auctions };
  return loaded;
}

export function handleGetLedger(
  req: Request,
  res: Response,
  statePath: string,
  sellerAddress: `0x${string}`,
  marketplacePath?: string
): void {
  try {
    const state = loadState(statePath, sellerAddress);
    const { jobs, auctions } = jobsForLedger(statePath, marketplacePath, sellerAddress);
    const scope = String(req.query.scope ?? "all");
    const owner = resolveJobOwnerFromRequest(req);

    const ledgerRecords = syncLedgerFromJobs(statePath, sellerAddress, jobs, auctions, state.records);
    let attributed = attributeLedgerRecords(ledgerRecords);
    try {
      attributed = applyJobAttribution(attributed, jobs, auctions);
    } catch (attrErr) {
      console.warn("[ledger] job attribution skipped:", attrErr);
    }

    const ownerPayerAddresses = resolveOwnerPayerAddresses(owner);
    const sessionPayers = resolveSessionActivityPayerAddresses(state.records);
    const activityPayerAddresses =
      ownerPayerAddresses.length > 0 ? ownerPayerAddresses : sessionPayers;

    const allRecords = attributed.slice().reverse();
    const hasOwner = !!(owner.sessionId || owner.payerAddress || owner.gatewayPayerAddress);

    let records: SpendRecord[];
    if (scope === "mine") {
      records = filterLedgerForOwnerScope(attributed, owner, jobs, auctions).slice().reverse();
    } else if (hasOwner && scope === "yours") {
      records = filterRecordsForOwner(attributed, owner, jobs, auctions).slice().reverse();
    } else {
      records = allRecords;
    }

    res.json({
      remainingDailyUsdc: remainingDailyUsdc(state.policy, ledgerRecords),
      records,
      totalCount: allRecords.length,
      activityPayerAddresses,
      meta: {
        ledgerVersion: LEDGER_BACKFILL_VERSION,
        jobsIndexed: jobs.length,
        materializedRecords: ledgerRecords.length,
      },
    });
  } catch (error) {
    console.error("[ledger] GET /api/ledger failed:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Ledger unavailable",
      meta: { ledgerVersion: LEDGER_BACKFILL_VERSION },
    });
  }
}
