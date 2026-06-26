export interface Health {
  ok: boolean;
  mode?: string;
  chain: string;
  seller: string;
}

export interface Merchant {
  id: string;
  label: string;
  category: string;
  priceUsdc?: string;
  enabled: boolean;
  target?: string;
}

export interface AgentBudget {
  role: string;
  dailyLimitUsdc: string;
  categories: string[];
  enabled: boolean;
}

export interface Policy {
  ownerAddress: string;
  weeklyLimitUsdc: string;
  dailyLimitUsdc: string;
  validUntil: number;
  merchants: Merchant[];
  agents: AgentBudget[];
}

export interface SpendRecord {
  id: string;
  at: number;
  agent: string;
  category: string;
  merchantId: string;
  amountUsdc: string;
  settlementId?: string;
  payerAddress?: string;
  executorAddress?: string;
  initiator?: "user" | "system" | "cli";
  status: string;
  reason?: string;
}

export interface AgentStatus {
  executorAddress: string | null;
  executorReady: boolean;
  sellerAddress: string;
  canRun: boolean;
  reason?: string;
  circleCli?: boolean;
  circleCliLoggedIn?: boolean;
  circleExecutorAddress?: string | null;
  /** Wallet + Gateway payer addresses for Activity "Mine" filter. */
  activityPayerAddresses?: string[];
  useCircleCli?: boolean;
  paymentMode?: string;
  gatewayBalanceUsdc?: string | null;
}

export interface CircleStatus {
  installed: boolean;
  runnable: boolean;
  loggedIn: boolean;
  testnet?: boolean;
  version: string | null;
  executorAddress: string | null;
  email?: string;
  gatewayBalanceUsdc?: string | null;
  chain: string;
}

export interface CircleAgentWallet {
  address: string;
  chain?: string;
  name?: string;
}

export interface StackStatus {
  leptonChecklist: boolean;
  arcCanteen: { installed: boolean; rpcUrl: string | null; docs: string };
  circleCli: { installed: boolean; runnable?: boolean; loggedIn?: boolean; version: string | null; docs: string };
  circleAgent: { traceApi: boolean; companion: string; arc101: string };
  butler: { marketplace: boolean; gateway: string; rpc: string };
}

export interface BatchTxResult {
  batchTx: string | null;
  status?: string;
  error?: string;
}

export interface BatchDecode {
  blockNumber: string;
  entries: { address: string; deltaRaw: string; usdc: string }[];
}

export interface AgentRunResult {
  mode: "x402" | "circle-cli";
  results: {
    merchantId: string;
    label: string;
    status: string;
    settlementId?: string;
    reason?: string;
    error?: string;
  }[];
  remainingDailyUsdc: string;
}

const API = (import.meta.env.VITE_API_URL as string | undefined)?.trim() || "http://localhost:3001";
export const IS_LOCAL_API = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(API.replace(/\/$/, ""));

function defaultTimeoutMs(): number {
  return IS_LOCAL_API ? 20_000 : 90_000;
}

function apiUnreachableMessage(): string {
  if (IS_LOCAL_API) {
    return `Cannot reach API at ${API} — is npm run dev:api running?`;
  }
  return `Cannot reach API at ${API} — the server may be waking up (Render free tier can take up to 60s). Wait and refresh, or open the API URL in a new tab first.`;
}

function responseOk(res: Response): boolean {
  if (res && typeof res.ok === "boolean") return res.ok;
  if (res && typeof res.status === "number") return res.status >= 200 && res.status < 300;
  return false;
}

function isRetryableHttp(status: number): boolean {
  return status === 404 || status === 502 || status === 503 || status === 504;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = defaultTimeoutMs(),
  maxRetries = IS_LOCAL_API ? 2 : 8
): Promise<T> {
  const retries = maxRetries;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${API}${path}`, { ...init, signal: controller.signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Request timed out (${path})`);
        }
        throw new Error(
          msg.includes("Failed to fetch") || msg.includes("NetworkError")
            ? apiUnreachableMessage()
            : msg
        );
      }
      if (!res || typeof res.status !== "number") {
        throw new Error(apiUnreachableMessage());
      }
      if (res.status === 0) {
        throw new Error(apiUnreachableMessage());
      }
      if (!responseOk(res)) {
        if (isRetryableHttp(res.status) && attempt < retries) {
          lastErr = new Error(`${res.status} ${path}`);
          await new Promise((r) => setTimeout(r, Math.min(attempt * 2_500, 12_000)));
          continue;
        }
        let detail =
          res.status === 502 || res.status === 503 || res.status === 504
            ? `API is waking up (${res.status}). Wait 30s and try again.`
            : `${res.status} ${path}`;
        let needsNewCode = false;
        try {
          const body = (await res.json()) as { error?: string; ok?: boolean; needsNewCode?: boolean };
          if (body.error) detail = body.error;
          needsNewCode = !!body.needsNewCode;
        } catch {
          /* ignore non-JSON error bodies */
        }
        const err = new Error(detail) as Error & { needsNewCode?: boolean };
        if (needsNewCode) err.needsNewCode = true;
        throw err;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const retryable =
        attempt < retries &&
        (lastErr.message.includes("Cannot reach API") ||
          lastErr.message.includes("timed out") ||
          lastErr.message.includes("waking up") ||
          isRetryableHttp(Number(lastErr.message.split(" ")[0])));
      if (!retryable) throw lastErr;
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2_500, 12_000)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(apiUnreachableMessage());
}

export const getHealth = () => request<Health>("/api/health", undefined, IS_LOCAL_API ? 15_000 : 25_000, 3);

/** Wake Render free tier before Circle login (health can take 30–60s when asleep). */
export async function wakeApiForLogin(maxWaitMs = IS_LOCAL_API ? 10_000 : 75_000): Promise<void> {
  const started = Date.now();
  let delay = 2_000;
  while (Date.now() - started < maxWaitMs) {
    try {
      const h = await getHealth();
      if (h.ok && h.mode !== "starting") return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1_000, 6_000);
  }
}

/** Poll until API health reports live (Render cold start / route bootstrap). */
export async function waitForApiReady(maxWaitMs = IS_LOCAL_API ? 15_000 : 180_000): Promise<Health> {
  const started = Date.now();
  let delay = 2_000;
  while (Date.now() - started < maxWaitMs) {
    try {
      const h = await getHealth();
      if (h.ok && h.mode !== "starting") return h;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1_000, 8_000);
  }
  return getHealth();
}

export interface AppConfig {
  chain: string;
  chainId: number;
  seller: string;
  arcRpc: string;
  gateway: string;
  webUrl: string;
}

export const getConfig = () => request<AppConfig>("/api/config");
export const getPolicy = () => request<Policy>("/api/policy");
export const getLedger = (scope?: "all" | "mine") =>
  request<{ remainingDailyUsdc: string; records: SpendRecord[]; totalCount?: number; activityPayerAddresses?: string[] }>(
    scope === "mine" ? "/api/ledger?scope=mine" : "/api/ledger"
  );
export const getAgentStatus = () => request<AgentStatus>("/api/agent/status");
export const getStackStatus = () => request<StackStatus>("/api/stack/status", undefined, IS_LOCAL_API ? 45_000 : 120_000);

export function getCircleStatus() {
  return request<CircleStatus>("/api/circle/status", undefined, IS_LOCAL_API ? 25_000 : 90_000);
}

export async function circleLoginInit(email: string) {
  for (let sendAttempt = 1; sendAttempt <= 2; sendAttempt++) {
    const started = await request<{ pending?: boolean; jobId: string; email: string }>(
      "/api/circle/login/init",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, testnet: true }),
      },
      12_000,
      6
    );

    const deadline = Date.now() + (IS_LOCAL_API ? 90_000 : 120_000);
    let delay = 1_500;
    let jobLost = false;
    while (Date.now() < deadline) {
      let status: {
        status: string;
        requestId?: string;
        email?: string;
        message?: string;
        hint?: string;
        otpPrefix?: string;
        error?: string;
        elapsedMs?: number;
      };
      try {
        status = await request(
          `/api/circle/login/init/${started.jobId}`,
          undefined,
          12_000,
          2
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        if (/job not found|expired/i.test(msg)) {
          jobLost = true;
          break;
        }
        if (/502|503|504|Cannot reach API/i.test(msg)) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay + 500, 3_000);
          continue;
        }
        throw err;
      }

      if (status.status === "pending") {
        if ((status.elapsedMs ?? 0) > 120_000) {
          throw new Error("Circle did not respond in time. Try Send login code again.");
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 500, 3_000);
        continue;
      }
      if (status.status === "error" || status.error) {
        throw new Error(status.error ?? "Failed to send OTP");
      }
      if (!status.requestId) {
        throw new Error("Code may have been sent, but the session ID was missing. Click Resend code.");
      }
      return {
        ok: true,
        requestId: status.requestId,
        email: status.email ?? started.email,
        message: status.message,
        hint: status.hint,
        otpPrefix: status.otpPrefix,
      };
    }

    if (jobLost && sendAttempt < 2) {
      await new Promise((r) => setTimeout(r, 1_500));
      continue;
    }
    if (jobLost) {
      throw new Error("Server restarted while sending the code. Tap Send login code once more.");
    }
    break;
  }
  throw new Error("No code received after 2 minutes. Tap Send login code to try again.");
}

export async function circleLoginVerify(
  requestId: string,
  otp: string,
  email?: string,
  otpPrefix?: string
) {
  const timeout = IS_LOCAL_API ? 90_000 : 120_000;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, otp, testnet: true, email, otpPrefix }),
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const body = await request<{
        ok?: boolean;
        email?: string;
        message?: string;
        wallets?: CircleAgentWallet[];
        executorAddress?: string | null;
      }>("/api/circle/login/verify", init, timeout, 1);
      return {
        ok: true as const,
        email: body.email,
        message: body.message,
        wallets: body.wallets ?? [],
        executorAddress: body.executorAddress ?? null,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const retryable =
        attempt < 5 &&
        /404|502|503|504|waking up|Cannot reach API/i.test(lastErr.message);
      if (!retryable) throw lastErr;
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2_000, 8_000)));
    }
  }
  throw lastErr ?? new Error("Verify failed");
}

export function circleLogout() {
  return request<{ ok: boolean }>("/api/circle/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export function getCircleWallets() {
  return request<{ chain: string; wallets: CircleAgentWallet[]; executorAddress: string | null }>(
    "/api/circle/wallets"
  );
}

export function setCircleExecutor(address: string) {
  return request<{ ok: boolean; executorAddress: string }>("/api/circle/executor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
}

export interface AgentCreditScore {
  agentId: string;
  score: number;
  successRate: number;
  tasksCompleted: number;
  revenueUsdc: string;
  avgEtaSeconds: number;
  reliability: number;
}

export interface AgentQuote {
  agentId: string;
  name: string;
  priceUsdc: string;
  etaSeconds: number;
  reputation: number;
  successRate: number;
  tasksCompleted: number;
  serviceUrl: string;
}

export interface MarketplaceAgentCard {
  id: string;
  name: string;
  tagline: string;
  category: string;
  servicePath: string;
  serviceUrl?: string;
  priceUsdc: string;
  etaSeconds: number;
  capabilities: string[];
  origin?: "local" | "external";
  domain?: string;
  x402Verified?: boolean;
  enabled?: boolean;
  quote: AgentQuote;
  credit?: AgentCreditScore;
}

export interface ExternalAgentPolicy {
  domainAllowlist: string[];
  maxPriceUsdc: number;
  baselineReputation: number;
  openDiscovery: boolean;
  requireX402Verified: boolean;
  requireAgentApproval?: boolean;
}

export interface AgentRegistryResponse {
  policy: ExternalAgentPolicy;
  registryPath: string;
  approvalsPath?: string;
  approvedCount?: number;
  agents: (MarketplaceAgentCard & { approved?: boolean })[];
  local: number;
  external: number;
}

export interface AgentEtf {
  id: string;
  name: string;
  description: string;
  agentIds: string[];
  bundlePriceUsdc: string;
  etaSeconds: number;
}

export interface AgentTreasury {
  label: string;
  balanceUsdc: string;
  spentUsdc: string;
  depositAddress: string;
  chain: string;
  autoSpend: boolean;
}

export interface AuctionEvent {
  at: number;
  kind: string;
  agentId?: string;
  agentName?: string;
  priceUsdc?: string;
  message?: string;
  round?: number;
}

export type QualityTier = "brief" | "standard" | "full";
export type AuctionMode = "single" | "etf";

export interface ReverseAuction {
  id: string;
  at: number;
  status: string;
  brief: string;
  category: string;
  minReputation: number;
  deadlineAt: number;
  bids: {
    agentId: string;
    agentName: string;
    priceUsdc: string;
    etaSeconds: number;
    reputation: number;
    at: number;
    round?: number;
    etfId?: string;
  }[];
  winnerId?: string;
  jobId?: string;
  qualityTier?: QualityTier;
  maxBudgetUsdc?: string;
  auctionMode?: AuctionMode;
  winnerEtfId?: string;
  autoAward?: boolean;
  bidRound?: number;
  lastRoundAt?: number;
  bidIntervalSeconds?: number;
  events?: AuctionEvent[];
}

export const getMarketplaceAgents = () =>
  request<MarketplaceAgentCard[]>("/api/marketplace/agents", undefined, 20_000);

export const getAgentRegistry = () =>
  request<AgentRegistryResponse>("/api/marketplace/registry", undefined, 20_000);

export function setAgentApproval(agentId: string, approved: boolean) {
  return request<{ ok: boolean; agentId: string; approved: boolean; approvedAgentIds: string[] }>(
    "/api/marketplace/registry/approvals",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, approved }),
    },
    15_000
  );
}

export function probeRegistryUrl(url: string, options?: { name?: string; save?: boolean }) {
  return request<{ probe: { ok: boolean; priceUsdc?: string; error?: string }; agent?: MarketplaceAgentCard; error?: string }>(
    "/api/marketplace/registry/probe",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, name: options?.name, save: options?.save ?? true }),
    },
    30_000
  );
}

export function registerExternalAgent(body: { serviceUrl: string; name?: string; category?: string }) {
  return request<{ agent: MarketplaceAgentCard; probe: unknown }>("/api/marketplace/registry/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 30_000);
}
export const getMarketplaceEtfs = () => request<AgentEtf[]>("/api/marketplace/etfs", undefined, 15_000);
export const getMarketplaceCredits = () =>
  request<AgentCreditScore[]>("/api/marketplace/credits", undefined, 15_000);
export const getMarketplaceTreasury = () =>
  request<AgentTreasury>("/api/marketplace/treasury", undefined, 15_000);
export const getMarketplaceAuctions = () =>
  request<ReverseAuction[]>("/api/marketplace/auctions", undefined, 15_000);

export const getMarketplaceAuction = (id: string) =>
  request<ReverseAuction>(`/api/marketplace/auctions/${encodeURIComponent(id)}`, undefined, 15_000);

export function createMarketplaceAuction(body: {
  brief: string;
  category?: string;
  minReputation?: number;
  ttlSeconds?: number;
  autoAward?: boolean;
  bidIntervalSeconds?: number;
  qualityTier?: QualityTier;
  maxBudgetUsdc?: string;
  auctionMode?: AuctionMode;
}) {
  return request<ReverseAuction>("/api/marketplace/auctions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function solicitMarketplaceAuctionBids(auctionId: string) {
  return request<ReverseAuction>(`/api/marketplace/auctions/${encodeURIComponent(auctionId)}/solicit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export function submitMarketplaceAuctionBid(
  auctionId: string,
  body: { agentId: string; priceUsdc?: string }
) {
  return request<ReverseAuction>(`/api/marketplace/auctions/${encodeURIComponent(auctionId)}/bids`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function awardMarketplaceAuction(auctionId: string, options?: { forceX402?: boolean }) {
  return request<unknown>(`/api/marketplace/auctions/${encodeURIComponent(auctionId)}/award`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ forceX402: options?.forceX402 ?? false }),
  }, 180_000);
}

export interface ButlerQuote {
  agentId: string;
  agentName: string;
  priceUsdc: string;
  reputation: number;
  etaSeconds: number;
}

export interface ButlerPhase {
  phase: "discover" | "negotiate" | "settle";
  at: number;
  message: string;
  quotes?: ButlerQuote[];
  auctionId?: string;
  bids?: number;
  winner?: { agentId: string; agentName: string; priceUsdc: string };
  settlementId?: string;
  ok?: boolean;
  error?: string;
}

export interface ButlerResult {
  ok: boolean;
  strategy: "auction" | "direct";
  mode?: "x402" | "circle-cli";
  brief: string;
  category: string;
  phases: ButlerPhase[];
  auction?: ReverseAuction;
  jobId?: string;
  summary?: string;
  error?: string;
}

/** @deprecated Use ButlerResult */
export type PayerAgentResult = ButlerResult;
/** @deprecated Use ButlerPhase */
export type PayerAgentPhase = ButlerPhase;
/** @deprecated Use ButlerQuote */
export type PayerAgentQuote = ButlerQuote;

export function runButler(body: {
  brief: string;
  category?: string;
  strategy?: "auction" | "direct";
  minReputation?: number;
  ttlSeconds?: number;
  qualityTier?: QualityTier;
  maxBudgetUsdc?: string;
  auctionMode?: AuctionMode;
  forceX402?: boolean;
}) {
  return request<ButlerResult>("/api/butler/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 300_000);
}

/** @deprecated Use runButler */
export const runPayerAgent = runButler;

export function getButlerReadiness() {
  return request<{ canRun: boolean; reason?: string; mode?: string }>("/api/butler/readiness");
}

/** @deprecated Use getButlerReadiness */
export const getPayerAgentReadiness = getButlerReadiness;

export function runMarketplaceWorkflow(etfId: string, brief?: string) {
  return request<{ job: unknown; orchestration: unknown }>("/api/marketplace/workflows/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ etfId, brief }),
  }, 600_000);
}

export interface TaskPlan {
  strategy: "etf" | "workflow" | "direct";
  agentIds: string[];
  etfId?: string;
  reason: string;
  estimatedUsdc: string;
  etaSeconds: number;
  router?: "planner" | "heuristic";
}

export interface AgentPlannerStatus {
  enabled: boolean;
  model: string;
}

export function getAgentPlannerStatus() {
  return request<AgentPlannerStatus>("/api/agent/planner");
}

export interface TaskRunResult {
  plan: TaskPlan;
  summary: string;
  job?: MarketplaceDeliverable;
  orchestration: {
    steps?: { agentId: string; ok: boolean; settlementId?: string; error?: string }[];
    totalUsdc?: string;
    mode?: string;
  };
}

export interface MarketplaceJobStep {
  agentId: string;
  label: string;
  priceUsdc: string;
  status: string;
  settlementId?: string;
  output?: unknown;
  error?: string;
}

export interface MarketplaceDeliverable {
  id: string;
  at: number;
  type: "direct" | "etf" | "auction";
  status: string;
  etfId?: string;
  brief?: string;
  totalUsdc: string;
  summary?: string;
  plan?: TaskPlan;
  steps: MarketplaceJobStep[];
  result?: unknown;
}

export function getMarketplaceDeliverables() {
  return request<MarketplaceDeliverable[]>("/api/marketplace/deliverables", undefined, 20_000);
}

export function getMarketplaceDeliverable(id: string) {
  return request<MarketplaceDeliverable>(`/api/marketplace/jobs/${encodeURIComponent(id)}`, undefined, 20_000);
}

export function runMarketplaceTask(body: {
  task: string;
  mode: "auto" | "manual";
  agentIds?: string[];
  etfId?: string | null;
}) {
  return request<TaskRunResult>("/api/marketplace/tasks/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 180_000);
}

export async function getSettlement(id: string): Promise<unknown> {
  const res = await fetch(`${API}/api/settlement/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`${res.status} settlement`);
  return res.json();
}

export async function getBatchTx(id: string): Promise<BatchTxResult> {
  const res = await fetch(`${API}/api/batch-tx/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`${res.status} batch-tx`);
  return res.json() as Promise<BatchTxResult>;
}

export async function decodeBatch(hash: string): Promise<BatchDecode> {
  const res = await fetch(`${API}/api/decode-batch/${encodeURIComponent(hash)}`);
  if (!res.ok) throw new Error(`${res.status} decode-batch`);
  return res.json() as Promise<BatchDecode>;
}

export async function updatePolicyOwner(ownerAddress: string): Promise<Policy> {
  return request("/api/policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerAddress }),
  });
}

export async function runAgent(options?: { forceX402?: boolean }): Promise<AgentRunResult> {
  return request("/api/agent/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ forceX402: options?.forceX402 ?? false }),
  });
}

export async function resetPolicy(): Promise<Policy> {
  return request("/api/policy/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export async function toggleMerchant(id: string, enabled: boolean, policy: Policy): Promise<Policy> {
  const merchants = policy.merchants.map((m) => (m.id === id ? { ...m, enabled } : m));
  return request("/api/policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchants }),
  });
}

export async function toggleAgent(role: string, enabled: boolean, policy: Policy): Promise<Policy> {
  const agents = policy.agents.map((a) => (a.role === role ? { ...a, enabled } : a));
  return request("/api/policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agents }),
  });
}

export function formatUsdc(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function shortAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
