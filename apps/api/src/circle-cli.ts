/**
 * Circle CLI integration — Lepton checklist item 04.
 * @see https://developers.circle.com/agent-stack/circle-cli
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCircleExecutorAddress, resolveCircleChain, saveCircleConfig, loadCircleConfig } from "./circle-config.ts";
import { formatPaymentError } from "./payment-errors.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Resolve circle binary: vendored script → PATH → global. */
export function resolveCircleBin(): string {
  if (process.env.CIRCLE_CLI_BIN) return process.env.CIRCLE_CLI_BIN;
  const local = resolve(ROOT, "scripts/circle.sh");
  if (existsSync(local)) return local;
  return "circle";
}

function runCircle(args: string[], opts?: { timeout?: number }): ReturnType<typeof spawnSync> {
  const bin = resolveCircleBin();
  const isScript = bin.endsWith(".sh");
  return spawnSync(isScript ? "bash" : bin, isScript ? [bin, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", CIRCLE_ACCEPT_TERMS: "1" },
    timeout: opts?.timeout,
  });
}

function circleOutputText(data: Record<string, unknown> | null, raw: string): string {
  if (!data) return raw;
  if (typeof data.message === "string") return data.message;
  const inner = data.data;
  if (inner && typeof inner === "object") {
    const msg = (inner as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  return raw;
}

function loginRequestPath(requestId: string): string {
  return join(homedir(), ".circle", "login-requests", `${requestId}.json`);
}

function readLoginRequest(requestId: string): { otpHead?: string; email?: string } | undefined {
  const path = loginRequestPath(requestId);
  if (!existsSync(path)) return undefined;
  try {
    const req = JSON.parse(readFileSync(path, "utf8")) as { otpHead?: string; email?: string };
    return req;
  } catch {
    return undefined;
  }
}

function readOtpPrefix(requestId: string): string | undefined {
  return readLoginRequest(requestId)?.otpHead;
}

function readLoginRequestEmail(requestId: string): string | undefined {
  const email = readLoginRequest(requestId)?.email;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

function normalizeOtp(otp: string): string {
  const trimmed = otp.trim().replace(/\s/g, "");
  const prefixed = trimmed.match(/^([A-Za-z0-9]{3})-(\d{6})$/);
  if (prefixed) return `${prefixed[1].toUpperCase()}-${prefixed[2]}`;
  if (/^\d{6}$/.test(trimmed)) return trimmed;
  return trimmed;
}

function formatLoginVerifyError(errText: string): { error: string; needsNewCode: boolean } {
  const text = errText.replace(/^Error:\s*/i, "").trim();
  if (/invalid or expired request id/i.test(text)) {
    return {
      error: "Code session expired (each verify attempt is one-time). Tap Resend code and use the new email OTP.",
      needsNewCode: true,
    };
  }
  if (/otp.*(not matched|invalid|expired)/i.test(text) || /user otp value is not matched/i.test(text)) {
    return {
      error: "Incorrect code. Request a new code — Circle allows only one verify attempt per email OTP.",
      needsNewCode: true,
    };
  }
  return { error: text || "Login failed", needsNewCode: false };
}

function parseCircleJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function runCircleJson(args: string[], timeout = 60_000): { ok: boolean; data: Record<string, unknown> | null; raw: string; err: string } {
  const r = runCircle([...args, "--output", "json"], { timeout });
  const raw = (r.stdout ?? "").trim();
  const err = (r.stderr ?? "").trim();
  const data = parseCircleJson(raw);
  return { ok: r.status === 0, data, raw, err };
}

let probeCache: { at: number; probe: CircleProbeResult } | null = null;
let loginCache: { at: number; loggedIn: boolean } | null = null;
let runnableCache: { at: number; ok: boolean } | null = null;

export interface CircleProbeResult {
  runnable: boolean;
  loggedIn: boolean;
  raw?: string;
  testnet?: boolean;
  email?: string;
}

/** Use saved login + executor when CLI probe is slow (wallet status can take 45s+). */
function sessionFromStoredConfig(): { loggedIn: boolean; email?: string } {
  const cfg = loadCircleConfig();
  if (!cfg.executorAddress?.startsWith("0x") || !cfg.email?.includes("@")) {
    return { loggedIn: false };
  }
  const updated = cfg.updatedAt ?? cfg.gatewayBalanceAt ?? 0;
  const ageSec = Math.floor(Date.now() / 1000) - updated;
  if (ageSec > 30 * 24 * 3600) return { loggedIn: false };
  return { loggedIn: true, email: cfg.email };
}

function parseWalletSession(
  data: Record<string, unknown> | null,
  raw: string,
  preferTestnet: boolean
): { loggedIn: boolean; email?: string; testnet: boolean } {
  const inner = data?.data as Record<string, unknown> | undefined;
  if (inner) {
    const netKey = preferTestnet ? "testnet" : "mainnet";
    const net = inner[netKey] as Record<string, unknown> | undefined;
    if (net) {
      return {
        loggedIn: String(net.tokenStatus ?? "") === "VALID",
        email: typeof net.email === "string" ? net.email : undefined,
        testnet: preferTestnet,
      };
    }
  }
  const testnetBlock = raw.split(/Network:\s*testnet/i)[1];
  if (preferTestnet && testnetBlock) {
    const emailMatch = testnetBlock.match(/Email:\s*(\S+@\S+)/i);
    return {
      loggedIn: /Status:\s*VALID/i.test(testnetBlock),
      email: emailMatch?.[1],
      testnet: true,
    };
  }
  const mainnetBlock = raw.split(/Network:\s*mainnet/i)[1]?.split(/Network:/i)[0] ?? "";
  const emailMatch = mainnetBlock.match(/Email:\s*(\S+@\S+)/i);
  return {
    loggedIn: /Status:\s*VALID/i.test(mainnetBlock) && !/Not logged in/i.test(mainnetBlock),
    email: emailMatch?.[1],
    testnet: false,
  };
}

/** Single CLI call for installed + runnable + session (cached; fast path from .data/circle-config.json). */
function refreshProbeFromCli(preferTestnet: boolean): CircleProbeResult {
  const now = Date.now();
  const { ok, data, raw, err } = runCircleJson(["wallet", "status"], 60_000);
  const text = `${raw}\n${err}`.trim();
  const broken =
    text.includes("ERR_MODULE_NOT_FOUND") ||
    text.includes("Cannot find module") ||
    text.includes("Circle CLI not installed");
  const session = parseWalletSession(data, text, preferTestnet);
  const stored = sessionFromStoredConfig();
  const loggedIn = (ok && session.loggedIn) || stored.loggedIn;
  const probe: CircleProbeResult = {
    runnable: !broken && (ok || stored.loggedIn),
    loggedIn,
    raw: text || undefined,
    testnet: session.testnet ?? stored.loggedIn,
    email: session.email ?? stored.email,
  };
  probeCache = { at: now, probe };
  runnableCache = { at: now, ok: probe.runnable };
  loginCache = { at: now, loggedIn: probe.loggedIn };
  return probe;
}

let probeRefreshInflight = false;

function scheduleProbeRefresh(preferTestnet = true): void {
  if (probeRefreshInflight) return;
  probeRefreshInflight = true;
  void runCircleAsync(["wallet", "status", "--output", "json"], 90_000)
    .then(({ ok, stdout, stderr }) => {
      const now = Date.now();
      const text = `${stdout}\n${stderr}`.trim();
      const broken =
        text.includes("ERR_MODULE_NOT_FOUND") ||
        text.includes("Cannot find module") ||
        text.includes("Circle CLI not installed");
      const data = parseCircleJson(stdout.trim());
      const session = parseWalletSession(data, text, preferTestnet);
      const stored = sessionFromStoredConfig();
      const loggedIn = (ok && session.loggedIn) || stored.loggedIn;
      const probe: CircleProbeResult = {
        runnable: !broken && (ok || stored.loggedIn),
        loggedIn,
        raw: text || undefined,
        testnet: session.testnet ?? stored.loggedIn,
        email: session.email ?? stored.email,
      };
      probeCache = { at: now, probe };
      runnableCache = { at: now, ok: probe.runnable };
      loginCache = { at: now, loggedIn: probe.loggedIn };
    })
    .finally(() => {
      probeRefreshInflight = false;
    });
}

export function probeCircleCli(preferTestnet = true): CircleProbeResult {
  const now = Date.now();
  const cacheMs = probeCache?.probe.loggedIn ? 300_000 : 30_000;
  if (probeCache && now - probeCache.at < cacheMs) return probeCache.probe;
  if (!circleCliInstalled()) {
    const probe = { runnable: false, loggedIn: false };
    probeCache = { at: now, probe };
    return probe;
  }
  const stored = sessionFromStoredConfig();
  if (stored.loggedIn) {
    const probe: CircleProbeResult = {
      runnable: true,
      loggedIn: true,
      testnet: preferTestnet,
      email: stored.email,
    };
    probeCache = { at: now, probe };
    runnableCache = { at: now, ok: true };
    loginCache = { at: now, loggedIn: true };
    scheduleProbeRefresh(preferTestnet);
    return probe;
  }
  return refreshProbeFromCli(preferTestnet);
}

export function invalidateCircleCache(): void {
  versionCache = null;
  loginCache = null;
  runnableCache = null;
  probeCache = null;
  gatewayBalCache = null;
}

const CACHE_MS = 60_000;
let versionCache: { at: number; v: string | null } | null = null;
let arcRpcCache: { at: number; url: string | null } | null = null;
let arcAvailCache: { at: number; ok: boolean } | null = null;
let gatewayBalCache: { at: number; address: string; balance: string | null } | null = null;
let gatewayRefreshInflight: string | null = null;

function runCircleAsync(args: string[], timeout = 45_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const bin = resolveCircleBin();
    const isScript = bin.endsWith(".sh");
    const child = spawn(isScript ? "bash" : bin, isScript ? [bin, ...args] : args, {
      env: { ...process.env, FORCE_COLOR: "0", CIRCLE_ACCEPT_TERMS: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: `${stderr}\nCircle CLI timed out`.trim() });
    }, timeout);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message });
    });
  });
}

/** Fast read for API handlers — avoids blocking the event loop on Circle CLI. */
export function getGatewayBalanceForApi(address: string | null | undefined): string | null {
  if (!address) return null;
  const key = address.toLowerCase();
  if (gatewayBalCache && gatewayBalCache.address === key && Date.now() - gatewayBalCache.at < 60_000) {
    return gatewayBalCache.balance;
  }
  const cfg = loadCircleConfig();
  if (cfg.executorAddress?.toLowerCase() === key && cfg.gatewayBalanceUsdc != null) {
    scheduleGatewayBalanceRefresh(address);
    return cfg.gatewayBalanceUsdc;
  }
  scheduleGatewayBalanceRefresh(address);
  return null;
}

export function scheduleGatewayBalanceRefresh(address: string): void {
  const key = address.toLowerCase();
  if (gatewayRefreshInflight === key) return;
  gatewayRefreshInflight = key;
  void (async () => {
    try {
      const chain = resolveCircleChain();
      const r = await runCircleAsync(
        ["gateway", "balance", "--address", address, "--chain", chain, "--all", "--output", "json"],
        45_000
      );
      if (!r.ok) return;
      const parsed = parseGatewayBalanceUsdc(r.stdout.trim());
      gatewayBalCache = { at: Date.now(), address: key, balance: parsed };
      if (parsed != null) {
        saveCircleConfig({
          executorAddress: address as `0x${string}`,
          gatewayBalanceUsdc: parsed,
          gatewayBalanceAt: Math.floor(Date.now() / 1000),
          chain,
        });
      }
    } finally {
      gatewayRefreshInflight = null;
    }
  })();
}

export function circleCliInstalled(): boolean {
  const globalCli = resolve(ROOT, ".circle-cli-global/node_modules/@circle-fin/cli/dist/index.js");
  const vendorCli = resolve(ROOT, ".vendor/circle-cli/dist/index.js");
  return existsSync(globalCli) || existsSync(vendorCli);
}

export function circleCliRunnable(): boolean {
  return probeCircleCli().runnable;
}

export function circleCliAvailable(): boolean {
  return circleCliInstalled();
}

export function circleCliLoggedIn(): boolean {
  return probeCircleCli().loggedIn;
}

/** Pick the first agent wallet as payer when logged in but none configured yet. */
export function ensureCircleExecutor(): `0x${string}` | null {
  const existing = resolveCircleExecutorAddress();
  if (existing) return existing;
  if (!circleCliLoggedIn()) return null;
  const chain = resolveCircleChain();
  const wallets = circleListAgentWallets(chain);
  const first = wallets[0]?.address;
  if (!first?.startsWith("0x")) return null;
  saveCircleConfig({ executorAddress: first as `0x${string}`, chain });
  return first as `0x${string}`;
}

export function circleWalletStatus(): CircleWalletStatus {
  const probe = probeCircleCli();
  return {
    loggedIn: probe.loggedIn,
    raw: probe.raw,
    testnet: probe.testnet,
  };
}

export interface CircleWalletStatus {
  loggedIn: boolean;
  raw?: string;
  testnet?: boolean;
}

export interface CircleLoginInitResult {
  ok: boolean;
  requestId?: string;
  email?: string;
  message?: string;
  otpPrefix?: string;
  error?: string;
}

export function circleLoginInit(email: string, testnet = true): CircleLoginInitResult {
  invalidateCircleCache();
  const args = ["wallet", "login", email, "--type", "agent"];
  if (testnet) args.push("--testnet");
  args.push("--init");
  const { ok, data, raw, err } = runCircleJson(args);
  if (!ok) {
    return { ok: false, error: err || raw || "Failed to send OTP" };
  }
  const message = circleOutputText(data, raw);
  let requestId = typeof data?.requestId === "string" ? data.requestId : undefined;
  if (!requestId) {
    const m = message.match(/--request\s+([0-9a-f-]{36})/i) ?? raw.match(/--request\s+([0-9a-f-]{36})/i);
    if (m) requestId = m[1];
  }
  if (!requestId) {
    return { ok: false, error: message || "No request ID returned from Circle CLI" };
  }
  const otpPrefix = readOtpPrefix(requestId);
  return { ok: true, requestId, email, message, otpPrefix };
}

export interface CircleLoginVerifyResult {
  ok: boolean;
  email?: string;
  message?: string;
  error?: string;
  needsNewCode?: boolean;
}

export function circleLoginVerify(requestId: string, otp: string, testnet = true): CircleLoginVerifyResult {
  invalidateCircleCache();
  const normalized = normalizeOtp(otp);
  const args = ["wallet", "login", "--request", requestId, "--otp", normalized];
  if (testnet) args.push("--testnet");
  const { ok, data, raw, err } = runCircleJson(args);
  if (!ok) {
    const errText = err || raw || "Login failed";
    const formatted = formatLoginVerifyError(errText);
    return { ok: false, error: formatted.error, needsNewCode: formatted.needsNewCode };
  }
  const message = circleOutputText(data, raw);
  const emailMatch = message.match(/Logged in as (.+)/i) ?? raw.match(/Logged in as (.+)/i);
  const email =
    emailMatch?.[1]?.trim() ??
    readLoginRequestEmail(requestId) ??
    probeCircleCli(testnet).email;
  return { ok: true, email, message };
}

export function circleLogout(): { ok: boolean; error?: string } {
  invalidateCircleCache();
  const r = runCircle(["wallet", "logout"], { timeout: 15_000 });
  return { ok: r.status === 0, error: r.status !== 0 ? (r.stderr ?? r.stdout ?? "").trim() : undefined };
}

export interface CircleAgentWallet {
  address: string;
  chain?: string;
  name?: string;
}

export function circleListAgentWallets(chain?: string): CircleAgentWallet[] {
  const resolved = chain ?? resolveCircleChain();
  const { ok, data } = runCircleJson(["wallet", "list", "--chain", resolved, "--type", "agent"], 30_000);
  if (!ok || !data) return [];
  const inner = data.data as Record<string, unknown> | undefined;
  const wallets = inner?.wallets ?? (data as { wallets?: unknown }).wallets;
  if (!Array.isArray(wallets)) return [];
  return wallets
    .map((w) => {
      const row = w as Record<string, unknown>;
      const address = String(row.address ?? row.walletAddress ?? "");
      if (!address.startsWith("0x")) return null;
      return {
        address,
        chain: typeof row.chain === "string" ? row.chain : typeof row.blockchain === "string" ? row.blockchain : resolved,
        name: typeof row.name === "string" ? row.name : undefined,
      };
    })
    .filter((w): w is CircleAgentWallet => !!w);
}

export function circleGatewayBalance(address: string, chain?: string): { ok: boolean; raw?: string; error?: string } {
  const resolved = chain ?? resolveCircleChain();
  const r = runCircle(["gateway", "balance", "--address", address, "--chain", resolved, "--all", "--output", "json"], {
    timeout: 30_000,
  });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr ?? r.stdout ?? "").trim() };
  }
  return { ok: true, raw: (r.stdout ?? "").trim() };
}

export function circleVersion(): string | null {
  const now = Date.now();
  if (versionCache && now - versionCache.at < CACHE_MS) return versionCache.v;
  if (!circleCliAvailable()) {
    versionCache = { at: now, v: null };
    return null;
  }
  const r = runCircle(["--version"], { timeout: 5_000 });
  const v = (r.stdout ?? r.stderr ?? "").trim() || null;
  versionCache = { at: now, v };
  return v;
}

export function arcCanteenAvailable(): boolean {
  const now = Date.now();
  if (arcAvailCache && now - arcAvailCache.at < CACHE_MS) return arcAvailCache.ok;
  const r = spawnSync("arc-canteen", ["--help"], { encoding: "utf8", timeout: 3_000 });
  const ok = r.status === 0;
  arcAvailCache = { at: now, ok };
  return ok;
}

export function arcCanteenRpcUrl(): string | null {
  const now = Date.now();
  if (arcRpcCache && now - arcRpcCache.at < CACHE_MS) return arcRpcCache.url;
  if (!arcCanteenAvailable()) {
    arcRpcCache = { at: now, url: null };
    return null;
  }
  const r = spawnSync("arc-canteen", ["rpc-url"], { encoding: "utf8", timeout: 3_000 });
  if (r.status !== 0) {
    arcRpcCache = { at: now, url: null };
    return null;
  }
  const line = (r.stdout ?? "").trim();
  const url = line.startsWith("http") ? line : null;
  arcRpcCache = { at: now, url };
  return url;
}

export interface CirclePayResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export function parseGatewayBalanceUsdc(raw?: string): string | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { data?: { total?: string; message?: string } };
    if (typeof data.data?.total === "string") return data.data.total;
    const match = data.data?.message?.match(/([\d.]+)\s*USDC/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function circleGatewayBalanceUsdc(address: string, chain?: string): string | null {
  const now = Date.now();
  if (
    gatewayBalCache &&
    gatewayBalCache.address === address.toLowerCase() &&
    now - gatewayBalCache.at < 60_000
  ) {
    return gatewayBalCache.balance;
  }
  const bal = circleGatewayBalance(address, chain);
  if (!bal.ok) return null;
  const parsed = parseGatewayBalanceUsdc(bal.raw);
  gatewayBalCache = { at: now, address: address.toLowerCase(), balance: parsed };
  if (parsed != null) {
    saveCircleConfig({
      gatewayBalanceUsdc: parsed,
      gatewayBalanceAt: Math.floor(Date.now() / 1000),
    });
  }
  return parsed;
}

/** Pay an x402 merchant via `circle services pay` (Circle CLI). Must be async — CLI calls back into this API for x402. */
export async function circleServicesPay(params: {
  url: string;
  address: string;
  chain?: string;
  estimate?: boolean;
}): Promise<CirclePayResult> {
  const chain = params.chain ?? resolveCircleChain();
  const args = [
    "services",
    "pay",
    params.url,
    "--address",
    params.address,
    "--chain",
    chain,
    "--output",
    "json",
  ];
  if (params.estimate) args.push("--estimate");

    const r = await runCircleAsync(args, 180_000);
    if (!r) {
      return { ok: false, stdout: "", stderr: "", error: "Circle CLI returned no result" };
    }
    const combined = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim();
    return {
      ok: r.ok,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.ok ? undefined : formatPaymentError(combined),
  };
}

/** Import executor private key into Circle CLI as a local wallet. */
export function circleImportLocalWallet(name: string, privateKey: string): boolean {
  const r = runCircle(["wallet", "import", name, "--private-key", privateKey], { timeout: 60_000 });
  return r.status === 0;
}

export function circleWalletListJson(chain?: string): string | null {
  const resolved = chain ?? resolveCircleChain();
  const r = runCircle(["wallet", "list", "--chain", resolved, "--type", "agent", "--output", "json"]);
  if (r.status !== 0) return null;
  return r.stdout?.trim() ?? null;
}

export function circleGatewayDeposit(params: {
  amount: string;
  address: string;
  chain?: string;
}): CirclePayResult {
  const chain = params.chain ?? resolveCircleChain();
  const r = runCircle(
    [
      "gateway",
      "deposit",
      "--amount",
      params.amount,
      "--address",
      params.address,
      "--chain",
      chain,
      "--method",
      "eco",
    ],
    { timeout: 120_000 }
  );
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
