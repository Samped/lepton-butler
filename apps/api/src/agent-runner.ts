import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  buildAgentTasks,
  type Merchant,
} from "@butler/core";
import { circleCliLoggedIn, circleCliRunnable, circleCliInstalled, circleServicesPay, ensureCircleExecutor, circleCliQuickRunnable } from "./circle-cli.ts";
import { loadCircleConfig, resolveCircleExecutorAddress, useCircleCliPayments } from "./circle-config.ts";
import { formatPaymentError } from "./payment-errors.ts";
import { hasActiveUserSession } from "./user-session.ts";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const STATE_PATH = resolve(ROOT, ".data/butler-state.json");

function getValidExecutorKey(): `0x${string}` | null {
  const pk = process.env.BUTLER_EXECUTOR_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!pk || !pk.startsWith("0x") || pk.length !== 66) return null;
  try {
    privateKeyToAccount(pk as `0x${string}`);
    return pk as `0x${string}`;
  } catch {
    return null;
  }
}

export function agentRunReadiness(): { canRun: boolean; reason?: string; mode?: string } {
  const pk = getValidExecutorKey();
  if (process.env.BUTLER_LITE_API === "true" && !hasActiveUserSession() && !pk) {
    return {
      canRun: false,
      mode: "circle-cli",
      reason: "Log in with Circle (Payer chip) — each browser session pays from its own wallet.",
    };
  }
  const circleAddr = resolveCircleExecutorAddress();
  const circleSession = circleCliLoggedIn();
  const cfg = loadCircleConfig();

  if (circleSession && circleAddr) return { canRun: true, mode: "circle-cli" };
  if (circleAddr && useCircleCliPayments() && (circleCliRunnable() || circleCliQuickRunnable())) {
    return { canRun: true, mode: "circle-cli" };
  }
  if (cfg.email && circleAddr && useCircleCliPayments()) {
    return { canRun: true, mode: "circle-cli" };
  }
  if (cfg.email?.includes("@") && circleAddr && circleSession) {
    return { canRun: true, mode: "circle-cli" };
  }
  if (pk) return { canRun: true, mode: "x402" };

  if (!circleCliRunnable()) {
    if (circleCliInstalled() && circleAddr) {
        return {
          canRun: false,
          mode: "circle-cli",
          reason:
            "Circle CLI is slow or unreachable. Ensure `scripts/circle.sh wallet status` works, then retry — or set BUTLER_EXECUTOR_PRIVATE_KEY for headless x402.",
        };
    }
    return {
      canRun: false,
      mode: "circle-cli",
      reason: "Circle CLI not installed. Run npm run circle:install on the API server.",
    };
  }

  if (!circleSession) {
    return {
      canRun: false,
      mode: "circle-cli",
      reason: "Log in with Circle (Payer chip) to pay agents via x402.",
    };
  }

  return {
    canRun: false,
    mode: "circle-cli",
    reason: "No Circle agent wallet found. Open Payer and create or select a wallet on ARC-TESTNET.",
  };
}

export interface AgentTask {
  agent: import("@butler/core").AgentRole;
  merchantId: string;
  label: string;
}

export interface TaskResult {
  merchantId: string;
  label: string;
  status: "settled" | "blocked" | "skipped" | "failed";
  settlementId?: string;
  reason?: string;
  error?: string;
}

export async function runAgentTasks(options: {
  apiBase: string;
  forceX402?: boolean;
}): Promise<{ mode: "x402" | "circle-cli"; results: TaskResult[] }> {
  const merchantsRes = await fetch(`${options.apiBase}/api/merchants`);
  if (!merchantsRes.ok) throw new Error(`merchants: ${merchantsRes.status}`);
  const merchants = (await merchantsRes.json()) as Merchant[];
  const merchantById = new Map(merchants.map((m) => [m.id, m]));
  const tasks = buildAgentTasks(merchants);

  const results: TaskResult[] = [];
  const readiness = agentRunReadiness();
  if (!readiness.canRun) {
    throw new Error(readiness.reason ?? "Payer not configured — Circle login required");
  }

  const pk = getValidExecutorKey();
  const circleAddr = ensureCircleExecutor() ?? resolveCircleExecutorAddress();
  const useCircleCli =
    !options.forceX402 &&
    (useCircleCliPayments() || circleCliLoggedIn() || (!pk && !!circleAddr && circleCliRunnable()));

  const client = useCircleCli ? null : new GatewayClient({ chain: "arcTestnet", privateKey: pk! });
  const taskBrief = process.env.BUTLER_TASK_BRIEF?.trim() || "policy merchant payment";

  for (const task of tasks) {
    const merchant = merchantById.get(task.merchantId);
    if (!merchant?.enabled) {
      results.push({ merchantId: task.merchantId, label: task.label, status: "skipped", reason: "disabled" });
      continue;
    }
    try {
      const params = new URLSearchParams({ brief: taskBrief });
      const url = `${options.apiBase}${merchant.target}?${params}`;
      if (useCircleCli) {
        let addr = circleAddr ?? null;
        if (!addr && pk) addr = privateKeyToAccount(pk).address;
        if (!addr) {
          results.push({
            merchantId: task.merchantId,
            label: task.label,
            status: "failed",
            error: "Circle payer address not set",
          });
          continue;
        }
        const pay = await circleServicesPay({ url, address: addr });
        results.push({
          merchantId: task.merchantId,
          label: task.label,
          status: pay?.ok ? "settled" : "failed",
          error: pay?.ok ? undefined : pay?.error ?? formatPaymentError(`${pay?.stderr ?? ""}\n${pay?.stdout ?? ""}`),
        });
      } else {
        const { status } = await client!.pay(url);
        results.push({
          merchantId: task.merchantId,
          label: task.label,
          status: status >= 200 && status < 300 ? "settled" : "failed",
          error: status >= 300 ? `HTTP ${status}` : undefined,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ merchantId: task.merchantId, label: task.label, status: "failed", error: message });
    }
  }

  return { mode: useCircleCli ? "circle-cli" : "x402", results };
}
