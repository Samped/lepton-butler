/**
 * Arc JSON-RPC URL resolution.
 * Prefers ARC_TESTNET_RPC, then arc-canteen ($RPC / rpc-url), then public fallback.
 * @see docs/LEPTON_CHECKLIST.md — arc-canteen rpc-url
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function readArcCanteenEnvRpc(): string | null {
  const envFile = join(homedir(), ".arc-canteen", "env");
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?RPC=(.+)$/);
    if (!match) continue;
    const url = match[1].trim().replace(/^["']|["']$/g, "");
    if (url.startsWith("http")) return url;
  }
  return null;
}

function arcCanteenRpcUrl(): string | null {
  const r = spawnSync("arc-canteen", ["rpc-url"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH ?? ""}` },
  });
  if (r.status !== 0) return null;
  const line = (r.stdout ?? "").trim();
  return line.startsWith("http") ? line : null;
}

export function resolveArcRpc(): string {
  return (
    process.env.ARC_TESTNET_RPC ??
    process.env.RPC ??
    readArcCanteenEnvRpc() ??
    arcCanteenRpcUrl() ??
    "https://rpc.testnet.arc.network"
  );
}

export const GATEWAY_WALLET_ARC = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

/** Demo settlement from circle-agent Arc 101 companion. */
export const PINNED_BATCH_TX: Record<string, `0x${string}`> = {
  "c9933054-6b34-44bb-8c04-e7e9e1b8352c":
    "0xfbad1baae7fd9b88f4e1b034a4236da02012870acbd6ae83b583e85528be396e",
};
