import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserSessionPaths } from "./user-session.ts";

function configPath(): string | null {
  const session = getUserSessionPaths();
  if (session) return session.configPath;
  return null;
}

export interface CircleConfig {
  executorAddress?: `0x${string}`;
  /** Circle Gateway smart-account payer seen in x402 settlements (differs from executor wallet). */
  gatewayPayerAddress?: `0x${string}`;
  chain?: string;
  email?: string;
  gatewayBalanceUsdc?: string;
  gatewayBalanceAt?: number;
  updatedAt?: number;
}

export function resolveCircleChain(): string {
  const raw = (process.env.CIRCLE_CHAIN ?? "ARC-TESTNET").trim();
  const upper = raw.toUpperCase().replace(/_/g, "-");
  if (upper === "ARC") return "ARC-TESTNET";
  return raw;
}

export function loadCircleConfig(): CircleConfig {
  const path = configPath();
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CircleConfig;
  } catch {
    return {};
  }
}

export function saveCircleConfig(patch: CircleConfig): CircleConfig {
  const path = configPath();
  if (!path) return { ...patch, updatedAt: Math.floor(Date.now() / 1000) };
  const next = { ...loadCircleConfig(), ...patch, updatedAt: Math.floor(Date.now() / 1000) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
}

export function resolveCircleExecutorAddress(): `0x${string}` | null {
  const fromEnv = process.env.CIRCLE_EXECUTOR_ADDRESS;
  if (fromEnv?.startsWith("0x")) return fromEnv as `0x${string}`;
  if (!getUserSessionPaths()) return null;
  const cfg = loadCircleConfig();
  if (cfg.executorAddress?.startsWith("0x")) return cfg.executorAddress;
  return null;
}

export function useCircleCliPayments(): boolean {
  return (
    process.env.BUTLER_USE_CIRCLE_CLI === "true" ||
    (!process.env.BUTLER_EXECUTOR_PRIVATE_KEY && !!resolveCircleExecutorAddress())
  );
}
