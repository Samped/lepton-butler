export * from "./brief-intent.ts";
export * from "./types.ts";
export * from "./policy.ts";
export * from "./store.ts";
export * from "./agent-tasks.ts";
export * from "./marketplace.ts";
export * from "./marketplace-store.ts";
export * from "./task-router.ts";
export * from "./auction.ts";
export * from "./agent-approvals.ts";
export * from "./agent-registry.ts";

import { getMarketplaceAgent as getFromRegistry } from "./agent-registry.ts";
/** Unified lookup — local Butler agents + registered external x402 agents. */
export const getMarketplaceAgent = getFromRegistry;
