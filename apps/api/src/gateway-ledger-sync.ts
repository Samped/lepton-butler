import { GATEWAY_FACILITATOR } from "@butler/arc";
import { saveState, loadState, type SpendRecord } from "@butler/core";

const GATEWAY_API =
  process.env.GATEWAY_API ?? process.env.GATEWAY_FACILITATOR_URL ?? GATEWAY_FACILITATOR;
const CACHE_MS = Number(process.env.BUTLER_GATEWAY_LEDGER_CACHE_MS ?? 5 * 60_000);
const MAX_PAGES = 50;

export interface GatewayTransfer {
  id: string;
  status: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  createdAt: string;
  updatedAt: string;
}

function gatewaySyncEnabled(): boolean {
  return process.env.BUTLER_GATEWAY_LEDGER_SYNC !== "false";
}

function parseLinkNext(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!part.includes('rel="next"')) continue;
    const url = part.split(";")[0]?.trim() ?? "";
    if (url.startsWith("<") && url.endsWith(">")) return url.slice(1, -1);
  }
  return null;
}

function microToUsdc(amount: string): string {
  const micro = BigInt(amount);
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

function gatewayStatusToSpend(status: string): SpendRecord["status"] {
  if (status === "failed") return "failed";
  if (status === "received" || status === "batched") return "pending";
  return "settled";
}

function transferToRecord(transfer: GatewayTransfer): SpendRecord {
  return {
    id: transfer.id,
    at: Math.floor(new Date(transfer.createdAt).getTime() / 1000),
    agent: "research",
    category: "apis",
    merchantId: "x402-transfer",
    amountUsdc: microToUsdc(transfer.amount),
    settlementId: transfer.id,
    payerAddress: transfer.fromAddress,
    initiator: "user",
    status: gatewayStatusToSpend(transfer.status),
  };
}

function recordKeys(record: SpendRecord): string[] {
  const keys = [record.id];
  if (record.settlementId?.trim()) keys.push(record.settlementId.trim());
  return keys;
}

export async function fetchGatewayTransfersToSeller(sellerAddress: string): Promise<GatewayTransfer[]> {
  const all: GatewayTransfer[] = [];
  let url: string | null =
    `${GATEWAY_API}/v1/x402/transfers?to=${encodeURIComponent(sellerAddress)}&pageSize=100`;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!response.ok) {
      throw new Error(`Gateway transfers HTTP ${response.status}`);
    }
    const data = (await response.json()) as { transfers?: GatewayTransfer[] };
    all.push(...(data.transfers ?? []));
    url = parseLinkNext(response.headers.get("Link"));
    pages += 1;
  }

  return all;
}

export function mergeGatewayTransfersIntoRecords(
  records: SpendRecord[],
  transfers: GatewayTransfer[]
): { records: SpendRecord[]; added: number } {
  const known = new Set<string>();
  for (const record of records) {
    for (const key of recordKeys(record)) known.add(key);
  }

  const additions: SpendRecord[] = [];
  for (const transfer of transfers) {
    if (known.has(transfer.id)) continue;
    const row = transferToRecord(transfer);
    additions.push(row);
    for (const key of recordKeys(row)) known.add(key);
  }

  if (additions.length === 0) return { records, added: 0 };
  return { records: [...records, ...additions], added: additions.length };
}

let cache: { at: number; seller: string; transfers: GatewayTransfer[] } | null = null;
let prefetchPromise: Promise<void> | null = null;

export async function prefetchGatewayLedgerCache(sellerAddress: string): Promise<void> {
  if (!gatewaySyncEnabled()) return;
  if (prefetchPromise) return prefetchPromise;
  prefetchPromise = (async () => {
    try {
      const transfers = await fetchGatewayTransfersToSeller(sellerAddress);
      cache = { at: Date.now(), seller: sellerAddress.toLowerCase(), transfers };
      console.log(`[ledger] gateway cache warmed (${transfers.length} transfers)`);
    } catch (error) {
      console.warn("[ledger] gateway prefetch failed:", error);
    } finally {
      prefetchPromise = null;
    }
  })();
  return prefetchPromise;
}

export async function syncLedgerFromGateway(
  sellerAddress: string,
  records: SpendRecord[],
  opts?: { force?: boolean; minPersisted?: number }
): Promise<{ records: SpendRecord[]; added: number; gatewayCount: number }> {
  if (!gatewaySyncEnabled()) {
    return { records, added: 0, gatewayCount: 0 };
  }

  const seller = sellerAddress.toLowerCase();
  const stale = !cache || cache.seller !== seller || Date.now() - cache.at > CACHE_MS;

  if (
    !opts?.force &&
    opts?.minPersisted &&
    records.length >= opts.minPersisted &&
    stale
  ) {
    void prefetchGatewayLedgerCache(sellerAddress);
    return { records, added: 0, gatewayCount: records.length };
  }

  if (stale || opts?.force) {
    try {
      const transfers = await fetchGatewayTransfersToSeller(sellerAddress);
      cache = { at: Date.now(), seller, transfers };
    } catch (error) {
      console.warn("[ledger] gateway sync failed:", error);
      if (!cache || cache.seller !== seller) {
        return { records, added: 0, gatewayCount: 0 };
      }
    }
  }

  const transfers = cache!.transfers;
  const { records: merged, added } = mergeGatewayTransfersIntoRecords(records, transfers);
  return { records: merged, added, gatewayCount: transfers.length };
}

export function persistGatewayLedgerBackfill(
  statePath: string,
  sellerAddress: `0x${string}`,
  records: SpendRecord[]
): void {
  const state = loadState(statePath, sellerAddress);
  saveState({ ...state, records }, statePath);
}
