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
  txHash?: string;
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
  openAiPlanner?: { enabled: boolean; model: string };
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

const BROWSER_SESSION_KEY = "butler.browserSession";

/** Per-browser id — isolates Circle login on the shared API server. */
export function getBrowserSessionId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = localStorage.getItem(BROWSER_SESSION_KEY);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem(BROWSER_SESSION_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** New session after sign-out so the next login is isolated. */
export function resetBrowserSessionId(): string {
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(BROWSER_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

function sessionHeaders(init?: RequestInit, withSession = true): Headers {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  if (withSession && typeof window !== "undefined") {
    headers.set("X-Butler-Session", getBrowserSessionId());
  }
  return headers;
}

const rawApi = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
/** Prod on Vercel: empty → same-origin /api/* (proxied in vercel.json). Dev: localhost:3001. */
const API = rawApi || (import.meta.env.DEV ? "http://localhost:3001" : "");
/** Empty API in prod = Vercel proxy — not local dev. */
export const IS_LOCAL_API =
  import.meta.env.DEV ||
  (!!API && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(API.replace(/\/$/, "")));

function defaultTimeoutMs(): number {
  return IS_LOCAL_API ? 20_000 : 90_000;
}

function apiDisplayUrl(): string {
  if (API) return API;
  if (typeof window !== "undefined") return window.location.origin;
  return "the API";
}

function apiUnreachableMessage(): string {
  if (IS_LOCAL_API) {
    return `Cannot reach API at ${apiDisplayUrl()} — is npm run dev:api running?`;
  }
  if (!API && typeof window !== "undefined") {
    return `Cannot reach API at ${window.location.origin}/api — the backend server may be offline. Wait a moment and try again, or open /api/health in a new tab.`;
  }
  return `Cannot reach API at ${apiDisplayUrl()} — wait a moment and try again, or open /api/health in a new tab.`;
}

function responseOk(res: Response): boolean {
  if (res && typeof res.ok === "boolean") return res.ok;
  if (res && typeof res.status === "number") return res.status >= 200 && res.status < 300;
  return false;
}

function isRetryableHttp(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = defaultTimeoutMs(),
  maxRetries = IS_LOCAL_API ? 2 : 8,
  withSession = true
): Promise<T> {
  const retries = maxRetries;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${API}${path}`, {
          ...init,
          headers: sessionHeaders(init, withSession),
          signal: controller.signal,
        });
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
            ? IS_LOCAL_API
              ? `API is waking up (${res.status}). Wait 30s and try again.`
              : `Backend offline (${res.status}). If /api/health shows "ok":true, tap Resend and try again. Otherwise run oracle-recover.sh on the VM.`
            : res.status === 429
              ? "Circle is rate-limiting logins. Wait 10–15 minutes, request a new code, then verify once."
              : `${res.status} ${path}`;
        let needsNewCode = res.status === 429;
        try {
          const body = (await res.json()) as { error?: string; ok?: boolean; needsNewCode?: boolean };
          if (body.error) {
            detail =
              /429|rate.?limit|too many requests|<!doctype/i.test(body.error)
                ? "Circle is rate-limiting logins. Wait 10–15 minutes, request a new code, then verify once."
                : body.error.length > 240
                  ? `${body.error.slice(0, 240)}…`
                  : body.error;
          }
          needsNewCode = needsNewCode || !!body.needsNewCode;
        } catch {
          /* ignore non-JSON error bodies */
        }
        if (
          !IS_LOCAL_API &&
          (res.status === 502 || res.status === 503 || res.status === 504) &&
          path.startsWith("/api/circle/login")
        ) {
          try {
            const h = await getHealthQuick();
            if (h.ok) {
              detail =
                "Login hit a temporary 502 while the API is online. Tap Resend for a fresh code, then Verify again.";
            }
          } catch {
            /* keep detail */
          }
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

export const getHealth = () =>
  request<Health>("/api/health", undefined, IS_LOCAL_API ? 15_000 : 25_000, IS_LOCAL_API ? 3 : 4);

/** Fast health for splash — don't block the UI on cold backend. */
export const getHealthQuick = () =>
  request<Health>("/api/health", undefined, IS_LOCAL_API ? 6_000 : 8_000, 2);

/** Best-effort wake; returns false instead of throwing so verify can still try. */
export async function tryWakeApiForLogin(maxWaitMs = IS_LOCAL_API ? 8_000 : 12_000): Promise<boolean> {
  const started = Date.now();
  let delay = 800;
  while (Date.now() - started < maxWaitMs) {
    try {
      const h = await getHealthQuick();
      if (h.ok && h.mode !== "starting") return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 500, 2_500);
  }
  return false;
}

/** Wake Render free tier before Circle login (health can take 30–90s when asleep). */
export async function wakeApiForLogin(maxWaitMs = IS_LOCAL_API ? 15_000 : 120_000): Promise<void> {
  const ok = await tryWakeApiForLogin(maxWaitMs);
  if (ok) return;
  throw new Error(
    IS_LOCAL_API
      ? `Cannot reach API at ${apiDisplayUrl()} — is npm run dev:api running?`
      : `Cannot reach API at ${apiDisplayUrl()} yet. If /api/health works in your browser, tap Verify & log in again.`
  );
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
    scope === "mine" ? "/api/ledger?scope=mine" : "/api/ledger",
    undefined,
    undefined,
    undefined,
    scope === "mine"
  );
export const getAgentStatus = () => request<AgentStatus>("/api/agent/status");
export const getStackStatus = () => request<StackStatus>("/api/stack/status", undefined, IS_LOCAL_API ? 45_000 : 120_000);

export function getCircleStatus() {
  return request<CircleStatus>("/api/circle/status", undefined, IS_LOCAL_API ? 25_000 : 90_000);
}

export type CircleLoginInitResult = {
  ok: true;
  requestId: string;
  email: string;
  message?: string;
  hint?: string;
  otpPrefix?: string;
};

export async function startCircleLoginJob(email: string) {
  /** Never retry POST init — each attempt sends another Circle OTP email. */
  return request<{ pending?: boolean; jobId: string; email: string }>(
    "/api/circle/login/init",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, testnet: true }),
    },
    IS_LOCAL_API ? 20_000 : 45_000,
    1
  );
}

const LOGIN_POLL_TIMEOUT = IS_LOCAL_API ? 15_000 : 25_000;
const LOGIN_POLL_RETRIES = IS_LOCAL_API ? 3 : 12;
const LOGIN_JOB_QUICK_TIMEOUT = IS_LOCAL_API ? 6_000 : 8_000;

export async function fetchCircleLoginJobOnce(jobId: string, quick = false) {
  return request<{
    status: string;
    requestId?: string;
    email?: string;
    message?: string;
    hint?: string;
    otpPrefix?: string;
    error?: string;
    elapsedMs?: number;
  }>(
    `/api/circle/login/init/${jobId}`,
    undefined,
    quick ? LOGIN_JOB_QUICK_TIMEOUT : LOGIN_POLL_TIMEOUT,
    quick ? 1 : LOGIN_POLL_RETRIES
  );
}

export async function pollCircleLoginJob(
  jobId: string,
  opts?: { onPending?: (elapsedMs: number) => void }
): Promise<CircleLoginInitResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (IS_LOCAL_API ? 120_000 : 180_000);
  let delay = 1_500;
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
        `/api/circle/login/init/${jobId}`,
        undefined,
        LOGIN_POLL_TIMEOUT,
        LOGIN_POLL_RETRIES
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Poll failed";
      if (/job not found|expired/i.test(msg)) {
        throw new Error("Server restarted while sending the code. Tap Resend, then enter the new code.");
      }
      if (/502|503|504|Cannot reach API|timed out|waking up|Bad Gateway|unavailable/i.test(msg)) {
        opts?.onPending?.(Date.now() - startedAt);
        await wakeApiForLogin(30_000);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 500, 4_000);
        continue;
      }
      throw err;
    }

    if (status.status === "pending") {
      opts?.onPending?.(status.elapsedMs ?? 0);
      if ((status.elapsedMs ?? 0) > 150_000) {
        throw new Error("Circle did not respond in time. Tap Resend and try again.");
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 500, 3_000);
      continue;
    }
    if (status.status === "error" || status.error) {
      throw new Error(status.error ?? "Failed to send OTP");
    }
    if (!status.requestId) {
      throw new Error("Code may have been sent, but the session ID was missing. Tap Resend.");
    }
    return {
      ok: true,
      requestId: status.requestId,
      email: status.email ?? "",
      message: status.message,
      hint: status.hint,
      otpPrefix: status.otpPrefix,
    };
  }
  throw new Error("Sending timed out. Tap Resend and try again.");
}

/** Start OTP send once, call onJobStarted as soon as the job exists, then poll for requestId. */
export async function beginLoginCodeSend(
  email: string,
  opts?: {
    onJobStarted?: (job: { jobId: string; email: string }) => void;
    onProgress?: (elapsedSec: number) => void;
  }
): Promise<CircleLoginInitResult & { email: string; jobId: string }> {
  const deadline = Date.now() + (IS_LOCAL_API ? 90_000 : 180_000);
  await tryWakeApiForLogin(IS_LOCAL_API ? 8_000 : 15_000);

  const started = await startCircleLoginJob(email);
  opts?.onJobStarted?.(started);

  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const result = await pollCircleLoginJob(started.jobId, {
        onPending: (elapsedMs) => opts?.onProgress?.(Math.floor(elapsedMs / 1000)),
      });
      return { ...result, email: result.email || started.email, jobId: started.jobId };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (/job not found|expired|Server restarted/i.test(lastErr.message)) throw lastErr;
      const retryable =
        Date.now() + 12_000 < deadline &&
        /API is down|Bad Gateway|Cannot reach API|502|503|504|timed out|waking up|unavailable|Server not responding/i.test(
          lastErr.message
        );
      if (!retryable) throw lastErr;
      opts?.onProgress?.(0);
      await tryWakeApiForLogin(15_000);
      await new Promise((r) => setTimeout(r, 2_500));
    }
  }
  throw (
    lastErr ??
    new Error(
      IS_LOCAL_API
        ? "Could not send code. Check the API is running and try again."
        : "Could not confirm the code was sent. If you got the email, enter the code and tap Verify."
    )
  );
}

/** @deprecated Use beginLoginCodeSend so the UI can show the OTP step immediately. */
export async function sendLoginCode(
  email: string,
  opts?: { onProgress?: (elapsedSec: number) => void }
): Promise<CircleLoginInitResult & { email: string }> {
  const result = await beginLoginCodeSend(email, { onProgress: opts?.onProgress });
  return result;
}

/** Poll until job has requestId (e.g. before verify when email arrived before poll finished). */
export async function waitForLoginRequestId(
  jobId: string,
  maxWaitMs = IS_LOCAL_API ? 60_000 : 90_000
): Promise<CircleLoginInitResult> {
  const deadline = Date.now() + maxWaitMs;
  let delay = 1_000;
  while (Date.now() < deadline) {
    try {
      const status = await fetchCircleLoginJobOnce(jobId);
      if (status.status === "pending") {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 500, 3_000);
        continue;
      }
      if (status.status === "error" || status.error) {
        throw new Error(status.error ?? "Failed to send OTP");
      }
      if (!status.requestId) {
        throw new Error("Code sent but session ID missing. Tap Verify again.");
      }
      return {
        ok: true,
        requestId: status.requestId,
        email: status.email ?? "",
        message: status.message,
        hint: status.hint,
        otpPrefix: status.otpPrefix,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Poll failed";
      if (/502|503|504|Cannot reach API|Bad Gateway|unavailable|timed out/i.test(msg)) {
        await wakeApiForLogin(Math.min(30_000, deadline - Date.now()));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Still connecting to server. Tap Verify again in a few seconds.");
}

/** Resolve Circle requestId — fast path when verify is tapped. */
export async function resolveLoginRequestId(
  jobId?: string | null,
  existing?: string | null
): Promise<string> {
  if (existing) return existing;
  if (!jobId) throw new Error("Missing login session. Tap Send code again.");

  const deadline = Date.now() + (IS_LOCAL_API ? 12_000 : 18_000);
  let delay = 600;
  while (Date.now() < deadline) {
    const status = await fetchCircleLoginJobOnce(jobId, true);
    if (status.requestId) return status.requestId;
    if (status.status === "error" || status.error) {
      throw new Error(status.error ?? "Failed to send OTP");
    }
    if (status.status !== "pending") break;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 400, 1_500);
  }
  throw new Error("Code session not ready yet. Wait 5 seconds and tap Verify & log in again.");
}

export async function circleLoginInit(email: string) {
  const result = await beginLoginCodeSend(email);
  return { ...result, email: result.email };
}

export async function circleLoginVerify(
  requestId: string,
  otp: string,
  email?: string,
  otpPrefix?: string,
  opts?: { onProgress?: (message: string) => void }
) {
  const timeout = IS_LOCAL_API ? 45_000 : 60_000;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, otp, testnet: true, email, otpPrefix }),
  };

  opts?.onProgress?.("Connecting to server…");
  await tryWakeApiForLogin(IS_LOCAL_API ? 10_000 : 90_000);
  opts?.onProgress?.("Verifying code…");
  try {
    const body = await request<{
      ok?: boolean;
      email?: string;
      message?: string;
      wallets?: CircleAgentWallet[];
      executorAddress?: string | null;
      needsNewCode?: boolean;
    }>("/api/circle/login/verify", init, timeout, IS_LOCAL_API ? 2 : 5);
    return {
      ok: true as const,
      email: body.email,
      message: body.message,
      wallets: body.wallets ?? [],
      executorAddress: body.executorAddress ?? null,
    };
  } catch (err) {
    const lastErr = err instanceof Error ? err : new Error(String(err));
    const needsNewCode = !!(lastErr as Error & { needsNewCode?: boolean }).needsNewCode;
    const rateLimited = /429|rate.?limit|too many requests|<!doctype/i.test(lastErr.message);
    if (rateLimited || needsNewCode) throw lastErr;
    if (/timed out|Request timed out/i.test(lastErr.message)) {
      throw new Error(
        "Verify timed out. Check /api/health, then tap Verify once more with the same code (codes expire quickly)."
      );
    }
    if (/502|503|504|Backend offline/i.test(lastErr.message)) {
      try {
        const h = await getHealthQuick();
        if (h.ok) {
          throw new Error(
            "Verify hit a temporary 502 while the API is online. Tap Resend for a fresh code, then Verify again."
          );
        }
      } catch (recheck) {
        if (recheck instanceof Error && !/502|503|504|Backend offline/i.test(recheck.message)) {
          throw recheck;
        }
      }
    }
    throw lastErr;
  }
}

export function fundCircleWallet() {
  return request<{ pending: boolean; address: string; chain: string }>("/api/circle/fund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }, 15_000, 2);
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
  sellerAddress?: string;
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

export class ButlerRunTimeoutError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super("Butler run timed out. Check Library — the task may still finish in the background.");
    this.name = "ButlerRunTimeoutError";
    this.runId = runId;
  }
}

function butlerPollDeadlineMs(body: {
  qualityTier?: QualityTier;
  auctionMode?: AuctionMode;
}): number {
  if (body.auctionMode === "etf" || body.qualityTier === "full") return 1_200_000;
  return 300_000;
}

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

function withSellerWallet(init: RequestInit | undefined, sellerWallet?: string | null): RequestInit {
  const headers = sessionHeaders(init);
  if (sellerWallet) headers.set("X-Butler-Seller-Wallet", sellerWallet);
  return { ...init, headers };
}

export function setAgentApproval(agentId: string, approved: boolean, sellerWallet?: string | null) {
  return request<{ ok: boolean; agentId: string; approved: boolean; approvedAgentIds: string[] }>(
    "/api/marketplace/registry/approvals",
    withSellerWallet(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, approved }),
      },
      sellerWallet
    ),
    15_000
  );
}

export function probeRegistryUrl(
  url: string,
  options?: { name?: string; save?: boolean; sellerWallet?: string | null }
) {
  return request<{ probe: { ok: boolean; priceUsdc?: string; error?: string }; agent?: MarketplaceAgentCard; error?: string }>(
    "/api/marketplace/registry/probe",
    withSellerWallet(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, name: options?.name, save: options?.save ?? true }),
      },
      options?.sellerWallet
    ),
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

export function getButlerRunStatus(runId: string) {
  return request<{
    status: string;
    result?: ButlerResult;
    error?: string;
    elapsedMs?: number;
  }>(`/api/butler/run/${runId}`, undefined, IS_LOCAL_API ? 20_000 : 30_000, IS_LOCAL_API ? 3 : 10);
}

/** Keep polling after the main deadline — server may still be paying agents. */
export async function pollButlerRunUntilDone(runId: string, maxWaitMs = 900_000): Promise<ButlerResult | null> {
  const deadline = Date.now() + maxWaitMs;
  let delay = 3_000;
  while (Date.now() < deadline) {
    try {
      const status = await getButlerRunStatus(runId);
      if (status.status === "ok" && status.result) return status.result;
      if (status.status === "error") return status.result ?? null;
      if (status.status === "pending" || status.status === "running") {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 500, 8_000);
        continue;
      }
      return null;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 1_000, 10_000);
    }
  }
  return null;
}

export async function runButler(body: {
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
  const started = await request<{ pending?: boolean; runId?: string; ok?: boolean }>(
    "/api/butler/run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    IS_LOCAL_API ? 45_000 : 30_000,
    IS_LOCAL_API ? 2 : 5
  );

  if (started.ok !== undefined && !started.pending) {
    return started as ButlerResult;
  }
  if (!started.runId) {
    throw new Error("Butler did not return a run id — retry the task.");
  }

  const runId = started.runId;
  const deadline = Date.now() + butlerPollDeadlineMs(body);
  let delay = 2_000;
  while (Date.now() < deadline) {
    try {
      const status = await getButlerRunStatus(runId);

      if (status.status === "pending" || status.status === "running") {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 500, 5_000);
        continue;
      }
      if (status.status === "error") {
        if (status.result) return status.result;
        throw new Error(status.error ?? "Butler run failed");
      }
      if (status.status === "ok" && status.result) {
        return status.result;
      }
      throw new Error(status.error ?? "Butler returned no result");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        Date.now() + delay < deadline &&
        /502|503|504|timed out|Cannot reach API|Backend offline|busy with a Butler/i.test(msg);
      if (!retryable) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 1_000, 8_000);
    }
  }
  throw new ButlerRunTimeoutError(runId);
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
  return request(`/api/settlement/${encodeURIComponent(id)}`);
}

export async function getBatchTx(id: string): Promise<BatchTxResult> {
  return request<BatchTxResult>(`/api/batch-tx/${encodeURIComponent(id)}`);
}

export async function decodeBatch(hash: string): Promise<BatchDecode> {
  return request<BatchDecode>(`/api/decode-batch/${encodeURIComponent(hash)}`);
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
