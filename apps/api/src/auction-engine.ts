import {
  getAgentCredits,
  loadMarketplaceState,
  mergeJobUpdates,
  pickAuctionWinner,
  processAuctionTick,
  recordAgentSuccess,
  patchMarketplaceState,
  saveMarketplaceState,
  saveMergedAuctions,
  treasuryCredit,
  type MarketplaceState,
  type ReverseAuction,
} from "@butler/core";
import { buildDirectJob, buildEtfJob, runMarketplaceWorkflow } from "./marketplace-orchestrator.ts";
import { finalizeCompletedJob } from "./marketplace-task.ts";

const awardingLocks = new Set<string>();

const STALE_PAYER_AUCTION_SECS = 180;
const SETTLEMENT_POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAuctionSettlement(opts: {
  statePath: string;
  sellerAddress: string;
  auctionId: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const mp = loadMarketplaceState(opts.statePath, opts.sellerAddress);
    const auction = mp.auctions.find((a) => a.id === opts.auctionId);
    if (!auction) return { ok: false, error: "Auction not found" };
    if (auction.status === "completed") return { ok: true };
    if (auction.status === "cancelled") {
      const job = auction.jobId ? mp.jobs.find((j) => j.id === auction.jobId) : undefined;
      const stepErr = job?.steps.find((s) => s.error)?.error;
      return { ok: false, error: stepErr ?? "Payment failed" };
    }
    if (auction.status === "awarded" && !awardingLocks.has(opts.auctionId)) {
      return { ok: false, error: "Settlement stalled — retrying" };
    }
    await sleep(SETTLEMENT_POLL_MS);
  }
  return { ok: false, error: "Settlement timed out — check Library for partial deliverables" };
}

async function resumeAwardedWorkflow(
  opts: {
    statePath: string;
    sellerAddress: string;
    apiBase: string;
    auctionId: string;
    forceX402?: boolean;
  },
  auction: ReverseAuction
): Promise<{ ok: boolean; error?: string }> {
  const credits = new Map(getAgentCredits(loadMarketplaceState(opts.statePath, opts.sellerAddress)).map((c) => [c.agentId, c]));
  const winner = pickAuctionWinner(auction, credits);
  if (!winner) return { ok: false, error: "No winner on stalled auction" };

  const job = winner.etfId
    ? buildEtfJob(winner.etfId, auction.brief)
    : buildDirectJob(winner.agentId, auction.brief);
  if (!job) return { ok: false, error: "Failed to create job" };
  job.type = winner.etfId ? "etf" : "auction";
  job.auctionId = auction.id;
  job.totalUsdc = winner.priceUsdc;
  if (winner.etfId) job.etfId = winner.etfId;

  awardingLocks.add(opts.auctionId);
  try {
    const result = await runMarketplaceWorkflow({
      apiBase: opts.apiBase,
      job,
      forceX402: opts.forceX402,
      initiator: (auction.butlerOwned ?? auction.payerAgentOwned) ? "user" : "system",
    });
    const finalized = finalizeCompletedJob(job, result);
    const completed = finalized.status === "completed";

    patchMarketplaceState(opts.statePath, opts.sellerAddress, (latest) => {
      let next = {
        ...latest,
        jobs: mergeJobUpdates(latest.jobs, [finalized]),
        auctions: latest.auctions.map((a) =>
          a.id === auction.id
            ? {
                ...a,
                status: completed ? ("completed" as const) : ("cancelled" as const),
                winnerId: winner.agentId,
                jobId: job.id,
                events: [
                  ...(a.events ?? []),
                  {
                    at: Math.floor(Date.now() / 1000),
                    kind: completed ? ("completed" as const) : ("cancelled" as const),
                    agentId: winner.agentId,
                    message: completed ? "x402 payment settled" : "Payment failed",
                  },
                ],
              }
            : a
        ),
      };
      if (result?.steps?.[0]?.ok) {
        next = recordAgentSuccess(next, winner.agentId, winner.priceUsdc, winner.etaSeconds);
        next = treasuryCredit(next, winner.priceUsdc);
      }
      return next;
    });

    const failedStep = result?.steps?.find((s) => !s.ok);
    return { ok: completed, error: failedStep?.error ?? (completed ? undefined : "Workflow payment failed") };
  } finally {
    awardingLocks.delete(opts.auctionId);
  }
}

function expireOrphanedAuctions(auctions: ReverseAuction[], now = Math.floor(Date.now() / 1000)): {
  auctions: ReverseAuction[];
  changed: boolean;
} {
  let changed = false;
  const next = auctions.map((a) => {
    if (a.status !== "open" || a.deadlineAt >= now) return a;
    if (!(a.butlerOwned ?? a.payerAgentOwned) || now - a.deadlineAt < STALE_PAYER_AUCTION_SECS) return a;
    changed = true;
    return {
      ...a,
      status: "cancelled" as const,
      events: [
        ...(a.events ?? []),
        {
          at: now,
          kind: "cancelled" as const,
          message: "Auction expired — Butler did not settle in time",
        },
      ],
    };
  });
  return { auctions: next, changed };
}

export function processMarketplaceAuctions(
  state: MarketplaceState,
  now = Math.floor(Date.now() / 1000)
): { state: MarketplaceState; toAward: string[] } {
  const { auctions: cleaned, changed } = expireOrphanedAuctions(state.auctions, now);
  const base = changed ? { ...state, auctions: cleaned } : state;
  const credits = getAgentCredits(base);
  const toAward: string[] = [];
  const auctions = base.auctions.map((auction) => {
    const tick = processAuctionTick(auction, credits, now);
    if (tick.needsAward && !(auction.butlerOwned ?? auction.payerAgentOwned)) toAward.push(tick.auction.id);
    return tick.auction;
  });
  return { state: { ...base, auctions }, toAward };
}

export async function executeAuctionAward(opts: {
  statePath: string;
  sellerAddress: string;
  apiBase: string;
  auctionId: string;
  forceX402?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (awardingLocks.has(opts.auctionId)) {
    return { ok: false, error: "Award already in progress" };
  }
  awardingLocks.add(opts.auctionId);

  try {
    let mp = loadMarketplaceState(opts.statePath, opts.sellerAddress);
    const auction = mp.auctions.find((a) => a.id === opts.auctionId);
    if (!auction) return { ok: false, error: "Auction not found" };
    if (auction.status === "completed") return { ok: true };
    if (auction.status === "awarded") {
      if (awardingLocks.has(opts.auctionId)) {
        return waitForAuctionSettlement(opts, 2 * 60_000);
      }
      return resumeAwardedWorkflow(opts, auction);
    }
    if (auction.bids.length === 0) return { ok: false, error: "No bids" };

    const credits = new Map(getAgentCredits(mp).map((c) => [c.agentId, c]));
    const winner = pickAuctionWinner(auction, credits);
    if (!winner) {
      const msg = auction.maxBudgetUsdc ? "No eligible winner within max budget" : "No eligible winner";
      return { ok: false, error: msg };
    }

    const job = winner.etfId
      ? buildEtfJob(winner.etfId, auction.brief)
      : buildDirectJob(winner.agentId, auction.brief);
    if (!job) return { ok: false, error: "Failed to create job" };
    job.type = winner.etfId ? "etf" : "auction";
    job.auctionId = auction.id;
    job.totalUsdc = winner.priceUsdc;
    if (winner.etfId) job.etfId = winner.etfId;

    patchMarketplaceState(opts.statePath, opts.sellerAddress, (latest) => ({
      auctions: latest.auctions.map((a) =>
        a.id === auction.id
          ? {
              ...a,
              status: "awarded" as const,
              winnerId: winner.etfId ? winner.etfId : winner.agentId,
              winnerEtfId: winner.etfId,
              events: [
                ...(a.events ?? []),
                {
                  at: Math.floor(Date.now() / 1000),
                  kind: "awarded" as const,
                  agentId: winner.agentId,
                  agentName: winner.agentName,
                  priceUsdc: winner.priceUsdc,
                  message: winner.etfId
                    ? `Awarded workflow ${winner.agentName} at $${winner.priceUsdc}`
                    : `Awarded to ${winner.agentName} at $${winner.priceUsdc}`,
                },
              ],
            }
          : a
      ),
    }));

    const result = await runMarketplaceWorkflow({
      apiBase: opts.apiBase,
      job,
      forceX402: opts.forceX402,
      initiator: (auction.butlerOwned ?? auction.payerAgentOwned) ? "user" : "system",
    });

    const finalized = finalizeCompletedJob(job, result);
    const completed = finalized.status === "completed";

    patchMarketplaceState(opts.statePath, opts.sellerAddress, (latest) => {
      let next = {
        ...latest,
        jobs: mergeJobUpdates(latest.jobs, [finalized]),
        auctions: latest.auctions.map((a) =>
          a.id === auction.id
            ? {
                ...a,
                status: completed ? ("completed" as const) : ("cancelled" as const),
                winnerId: winner.agentId,
                jobId: job.id,
                events: [
                  ...(a.events ?? []),
                  {
                    at: Math.floor(Date.now() / 1000),
                    kind: completed ? ("completed" as const) : ("cancelled" as const),
                    agentId: winner.agentId,
                    message: completed ? "x402 payment settled" : "Payment failed",
                  },
                ],
              }
            : a
        ),
      };
      if (result?.steps?.[0]?.ok) {
        next = recordAgentSuccess(next, winner.agentId, winner.priceUsdc, winner.etaSeconds);
        next = treasuryCredit(next, winner.priceUsdc);
      }
      return next;
    });
    const failedStep = result?.steps?.find((s) => !s.ok);
    const failError = failedStep?.error ?? (completed ? undefined : "Workflow payment failed");
    return { ok: completed, error: failError };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Award failed" };
  } finally {
    awardingLocks.delete(opts.auctionId);
  }
}

export function startAuctionEngine(opts: {
  statePath: string;
  sellerAddress: string;
  apiBase: string;
  intervalMs?: number;
}) {
  const intervalMs = opts.intervalMs ?? 5_000;

  const tick = () => {
    try {
      const mp = loadMarketplaceState(opts.statePath, opts.sellerAddress);
      const { state, toAward } = processMarketplaceAuctions(mp);
      if (state.auctions !== mp.auctions) {
        saveMergedAuctions(opts.statePath, opts.sellerAddress, state.auctions);
      }

      for (const id of toAward) {
        void executeAuctionAward({
          statePath: opts.statePath,
          sellerAddress: opts.sellerAddress,
          apiBase: opts.apiBase,
          auctionId: id,
        }).then((res) => {
          if (!res.ok && res.error) {
            console.warn(`[auction-engine] auto-award ${id}: ${res.error}`);
          }
        });
      }
    } catch (error) {
      console.warn("[auction-engine] tick failed:", error instanceof Error ? error.message : error);
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);
  console.log(`[auction-engine] running every ${intervalMs}ms`);
  return () => clearInterval(handle);
}

export function loadProcessedAuctions(
  statePath: string,
  sellerAddress: string
): { auctions: ReverseAuction[]; toAward: string[] } {
  const mp = loadMarketplaceState(statePath, sellerAddress);
  const { state, toAward } = processMarketplaceAuctions(mp);
  const merged =
    state.auctions !== mp.auctions
      ? saveMergedAuctions(statePath, sellerAddress, state.auctions)
      : mp;
  return { auctions: merged.auctions.slice(-30).reverse(), toAward };
}
