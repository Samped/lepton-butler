import type { MarketplaceJob, ReverseAuction } from "@butler/core";
import type { Request } from "express";
import { resolveCircleExecutorAddress } from "./circle-config.ts";
import { sessionIdFromRequest } from "./user-session.ts";

export type JobOwner = {
  sessionId?: string;
  payerAddress?: string;
};

export function resolveJobOwnerFromRequest(req: Request): JobOwner {
  return {
    sessionId: sessionIdFromRequest(req) ?? undefined,
    payerAddress: resolveCircleExecutorAddress() ?? undefined,
  };
}

export function stampJobOwner(job: MarketplaceJob, owner?: JobOwner): MarketplaceJob {
  if (!owner?.sessionId && !owner?.payerAddress) return job;
  return {
    ...job,
    ownerSessionId: owner.sessionId ?? job.ownerSessionId,
    payerAddress: owner.payerAddress ?? job.payerAddress,
  };
}

export function stampJobFromAuction(job: MarketplaceJob, auction: Pick<ReverseAuction, "ownerSessionId" | "payerAddress">): MarketplaceJob {
  return stampJobOwner(job, {
    sessionId: auction.ownerSessionId,
    payerAddress: auction.payerAddress,
  });
}

export function stampAuctionOwner(auction: ReverseAuction, owner?: JobOwner): ReverseAuction {
  if (!owner?.sessionId && !owner?.payerAddress) return auction;
  return {
    ...auction,
    ownerSessionId: owner.sessionId ?? auction.ownerSessionId,
    payerAddress: owner.payerAddress ?? auction.payerAddress,
  };
}

/** Only show jobs this browser session (or payer wallet) created. */
export function jobVisibleToOwner(job: MarketplaceJob, owner: JobOwner): boolean {
  if (owner.sessionId && job.ownerSessionId) {
    return job.ownerSessionId === owner.sessionId;
  }
  if (owner.payerAddress && job.payerAddress) {
    return job.payerAddress.toLowerCase() === owner.payerAddress.toLowerCase();
  }
  return false;
}

export function filterJobsForOwner(jobs: MarketplaceJob[], owner: JobOwner): MarketplaceJob[] {
  if (!owner.sessionId && !owner.payerAddress) return [];
  return jobs.filter((j) => jobVisibleToOwner(j, owner));
}
