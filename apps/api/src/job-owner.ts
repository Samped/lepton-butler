import type { MarketplaceJob, ReverseAuction } from "@butler/core";
import type { Request } from "express";
import { loadCircleConfig, resolveCircleExecutorAddress } from "./circle-config.ts";
import { sessionIdFromRequest } from "./user-session.ts";

export type JobOwner = {
  sessionId?: string;
  payerAddress?: string;
  gatewayPayerAddress?: string;
};

export function resolveJobOwnerFromSession(sessionId?: string): JobOwner {
  const cfg = loadCircleConfig();
  return {
    sessionId,
    payerAddress: resolveCircleExecutorAddress() ?? undefined,
    gatewayPayerAddress: cfg.gatewayPayerAddress,
  };
}

export function resolveJobOwnerFromRequest(req: Request): JobOwner {
  const cfg = loadCircleConfig();
  return {
    sessionId: sessionIdFromRequest(req) ?? undefined,
    payerAddress: resolveCircleExecutorAddress() ?? undefined,
    gatewayPayerAddress: cfg.gatewayPayerAddress,
  };
}

/** Wallet + Gateway payer addresses for the connected session. */
export function resolveOwnerPayerAddresses(owner: JobOwner): string[] {
  const set = new Set<string>();
  if (owner.payerAddress) set.add(owner.payerAddress.toLowerCase());
  if (owner.gatewayPayerAddress) set.add(owner.gatewayPayerAddress.toLowerCase());
  return [...set];
}

function ownerHasIdentity(owner: JobOwner): boolean {
  return !!owner.sessionId || resolveOwnerPayerAddresses(owner).length > 0;
}

function jobPayerMatchesOwner(job: MarketplaceJob, owner: JobOwner): boolean {
  const addrs = resolveOwnerPayerAddresses(owner);
  if (!job.payerAddress || addrs.length === 0) return false;
  return addrs.includes(job.payerAddress.toLowerCase());
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
  if (owner.sessionId && job.ownerSessionId && job.ownerSessionId === owner.sessionId) {
    return true;
  }
  if (jobPayerMatchesOwner(job, owner)) return true;
  return false;
}

export function filterJobsForOwner(jobs: MarketplaceJob[], owner: JobOwner): MarketplaceJob[] {
  if (!ownerHasIdentity(owner)) return [];
  return jobs.filter((j) => jobVisibleToOwner(j, owner));
}

export function auctionVisibleToOwner(auction: ReverseAuction, owner: JobOwner): boolean {
  if (owner.sessionId && auction.ownerSessionId && auction.ownerSessionId === owner.sessionId) {
    return true;
  }
  const addrs = resolveOwnerPayerAddresses(owner);
  if (auction.payerAddress && addrs.length > 0) {
    return addrs.includes(auction.payerAddress.toLowerCase());
  }
  return false;
}

export function filterAuctionsForOwner(auctions: ReverseAuction[], owner: JobOwner): ReverseAuction[] {
  if (!ownerHasIdentity(owner)) return [];
  return auctions.filter((a) => auctionVisibleToOwner(a, owner));
}
