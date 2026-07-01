import type { Request, Response } from "express";
import {
  createDefaultPolicy,
  loadState,
  saveState,
  type AgentBudget,
  type ButlerPolicy,
  type Merchant,
  type SpendRecord,
} from "@butler/core";
import { resolveCircleExecutorAddress } from "./circle-config.ts";

function parseUsdcMicro(amount: string): bigint | null {
  const trimmed = String(amount ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, 6);
  try {
    const micro = BigInt(whole) * 1_000_000n + BigInt(padded);
    return micro > 0n ? micro : null;
  } catch {
    return null;
  }
}

function validatePolicy(policy: ButlerPolicy): string | null {
  const daily = parseUsdcMicro(policy.dailyLimitUsdc);
  const weekly = parseUsdcMicro(policy.weeklyLimitUsdc);
  if (daily == null) return "Daily spend cap must be a positive USDC amount (e.g. 25 or 25.50).";
  if (weekly == null) return "Weekly spend cap must be a positive USDC amount.";
  if (weekly < daily) return "Weekly cap must be greater than or equal to the daily cap.";

  const now = Math.floor(Date.now() / 1000);
  if (typeof policy.validUntil !== "number" || !Number.isFinite(policy.validUntil)) {
    return "Policy expiry is invalid.";
  }
  if (policy.validUntil < now) return "Policy expiry must be in the future.";

  for (const agent of policy.agents) {
    const cap = parseUsdcMicro(agent.dailyLimitUsdc);
    if (cap == null) return `Agent "${agent.role}" needs a positive daily limit.`;
    if (cap > daily) return `Agent "${agent.role}" daily limit cannot exceed the global daily cap.`;
  }

  for (const merchant of policy.merchants) {
    if (merchant.priceUsdc != null && parseUsdcMicro(merchant.priceUsdc) == null) {
      return `Merchant "${merchant.label}" has an invalid price.`;
    }
  }

  return null;
}

function mergeAgents(current: AgentBudget[], patch: unknown): AgentBudget[] {
  if (!Array.isArray(patch)) return current;
  const updates = patch as Partial<AgentBudget>[];
  return current.map((agent) => {
    const row = updates.find((u) => u.role === agent.role);
    return row ? { ...agent, ...row, role: agent.role } : agent;
  });
}

function mergeMerchants(current: Merchant[], patch: unknown): Merchant[] {
  if (!Array.isArray(patch)) return current;
  const updates = patch as Partial<Merchant>[];
  return current.map((merchant) => {
    const row = updates.find((u) => u.id === merchant.id);
    return row ? { ...merchant, ...row, id: merchant.id } : merchant;
  });
}

export function mergePolicyPatch(current: ButlerPolicy, body: Record<string, unknown>): ButlerPolicy {
  const next: ButlerPolicy = {
    ...current,
    version: 1,
  };

  if (body.dailyLimitUsdc != null) next.dailyLimitUsdc = String(body.dailyLimitUsdc).trim();
  if (body.weeklyLimitUsdc != null) next.weeklyLimitUsdc = String(body.weeklyLimitUsdc).trim();
  if (body.validUntil != null) next.validUntil = Number(body.validUntil);
  if (typeof body.ownerAddress === "string" && body.ownerAddress.startsWith("0x")) {
    next.ownerAddress = body.ownerAddress as `0x${string}`;
  }

  if (body.agents != null) next.agents = mergeAgents(current.agents, body.agents);
  if (body.merchants != null) next.merchants = mergeMerchants(current.merchants, body.merchants);

  return next;
}

export function handleGetPolicy(
  res: Response,
  statePath: string,
  seller: `0x${string}` = "0x0000000000000000000000000000000000000001"
): void {
  const state = loadState(statePath, seller);
  res.json(state.policy);
}

export function handlePutPolicy(
  req: Request,
  res: Response,
  statePath: string,
  seller: `0x${string}` = "0x0000000000000000000000000000000000000001"
): void {
  try {
    const state = loadState(statePath, seller);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = mergePolicyPatch(state.policy, body);
    const err = validatePolicy(next);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    state.policy = next;
    saveState(state, statePath);
    res.json(state.policy);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Policy update failed" });
  }
}

export function handleResetPolicy(
  req: Request,
  res: Response,
  statePath: string,
  seller: `0x${string}` = "0x0000000000000000000000000000000000000001"
): void {
  try {
    const executor = resolveCircleExecutorAddress();
    const fromBody = String(req.body?.ownerAddress ?? "").trim();
    const owner = (
      fromBody.startsWith("0x")
        ? fromBody
        : executor?.startsWith("0x")
          ? executor
          : "0x0000000000000000000000000000000000000001"
    ) as `0x${string}`;
    const state = { policy: createDefaultPolicy(owner), records: [] as SpendRecord[] };
    saveState(state, statePath);
    res.json(state.policy);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Policy reset failed" });
  }
}
