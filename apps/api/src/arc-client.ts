import { createPublicClient, http } from "viem";
import { arcTestnet, DELEGATION_MANAGER, resolveArcRpc } from "@butler/arc";

const RPC_TIMEOUT_MS = 4_000;
const CACHE_MS = 60_000;

let cached: { at: number; deployed: boolean; rpcError?: string } | null = null;

export async function isDelegationFrameworkDeployed(): Promise<{
  deployed: boolean;
  rpcError?: string;
}> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) {
    return { deployed: cached.deployed, rpcError: cached.rpcError };
  }

  try {
    const rpc = resolveArcRpc();
    const client = createPublicClient({
      chain: arcTestnet,
      transport: http(rpc, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }),
    });
    const code = await client.getBytecode({ address: DELEGATION_MANAGER });
    const result = { deployed: !!code && code !== "0x" };
    cached = { at: now, ...result };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Arc RPC unavailable";
    const result = { deployed: false, rpcError: message };
    cached = { at: now, ...result };
    return result;
  }
}
