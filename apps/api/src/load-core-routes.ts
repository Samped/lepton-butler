/**
 * Fast-boot routes (Circle login, config). Loaded synchronously before heavy x402/marketplace routes.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { GATEWAY_FACILITATOR, resolveArcRpc, ARC_EIP155 } from "@butler/arc";
import {
  circleCliInstalled,
  circleCliQuickRunnable,
  circleCliLoggedIn,
  circleGatewayBalance,
  circleListAgentWallets,
  circleLoginVerifyAsync as circleCliLoginVerify,
  circleLogout,
  circleVersion,
  ensureCircleExecutor,
  getGatewayBalanceForApi,
  probeCircleCli,
  scheduleGatewayBalanceRefresh,
} from "./circle-cli.ts";
import { getCircleLoginInitJob, startCircleLoginInitJob } from "./circle-login-jobs.ts";
import { loadCircleConfig, resolveCircleExecutorAddress, resolveCircleChain, saveCircleConfig } from "./circle-config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const WEB_URL = process.env.WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? 5174}`;

export function loadCoreRoutes(app: Express): void {
  app.get("/api/config", (_req, res) => {
    res.json({
      chain: ARC_EIP155,
      chainId: 5042002,
      seller: process.env.BUTLER_SELLER_ADDRESS ?? "0x933a2405f84c224be1ef373ba16e992e1f459682",
      arcRpc: resolveArcRpc(),
      gateway: process.env.GATEWAY_FACILITATOR_URL ?? GATEWAY_FACILITATOR,
      webUrl: WEB_URL,
    });
  });

  app.get("/api/circle/status", (_req, res) => {
    try {
      const cfg = loadCircleConfig();
      const probe = probeCircleCli();
      let executor = resolveCircleExecutorAddress();
      if (!executor && probe.loggedIn) {
        void Promise.resolve().then(() => ensureCircleExecutor());
      }
      const gatewayBalanceUsdc = getGatewayBalanceForApi(executor);
      res.json({
        installed: circleCliInstalled(),
        runnable: probe.runnable,
        loggedIn: probe.loggedIn,
        testnet: probe.testnet ?? true,
        version: circleVersion(),
        executorAddress: executor,
        email: cfg.email ?? probe.email,
        chain: cfg.chain ?? resolveCircleChain(),
        gatewayBalanceUsdc,
        session: probe.raw,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Circle status failed" });
    }
  });

  app.post("/api/circle/login/init", (req, res) => {
    try {
      const email = String(req.body?.email ?? "").trim();
      if (!email.includes("@")) {
        res.status(400).json({ error: "Valid email required" });
        return;
      }
      if (!circleCliInstalled() || !circleCliQuickRunnable()) {
        res.status(503).json({ error: "Circle CLI not installed. Run npm run circle:install on the server." });
        return;
      }
      const testnet = req.body?.testnet !== false;
      const jobId = startCircleLoginInitJob(email, testnet);
      res.status(202).json({ pending: true, jobId, email });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to send OTP",
      });
    }
  });

  app.get("/api/circle/login/init/:jobId", (req, res) => {
    const job = getCircleLoginInitJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Login job not found or expired — send a new code." });
      return;
    }
    if (job.status === "pending") {
      res.json({ status: "pending", email: job.email });
      return;
    }
    const result = job.result;
    if (!result?.ok) {
      res.status(500).json({ status: "error", error: result?.error ?? "Failed to send OTP" });
      return;
    }
    res.json({
      status: "ok",
      ok: true,
      requestId: result.requestId,
      email: result.email,
      message: result.message,
      otpPrefix: result.otpPrefix,
      hint: result.otpPrefix
        ? `Enter ${result.otpPrefix}-123456 or the 6 digits from your email (one verify attempt per code).`
        : "Check your email for a code like B1X-123456 (6 digits also works). One verify attempt per code.",
    });
  });

  app.post("/api/circle/login/verify", async (req, res) => {
    try {
      const requestId = String(req.body?.requestId ?? "").trim();
      const otp = String(req.body?.otp ?? "").trim();
      if (!requestId || !otp) {
        res.status(400).json({ error: "requestId and otp required" });
        return;
      }
      const emailHint = String(req.body?.email ?? "").trim();
      const result = await circleCliLoginVerify(requestId, otp, req.body?.testnet !== false);
      if (!result || !result.ok) {
        res.status(401).json({ error: result?.error ?? "Login failed", needsNewCode: result?.needsNewCode ?? false });
        return;
      }
      const savedEmail = result.email ?? (emailHint.includes("@") ? emailHint : undefined);
      if (savedEmail) saveCircleConfig({ email: savedEmail });
      const chain = resolveCircleChain();
      const wallets = circleListAgentWallets(chain);
      const first = wallets[0]?.address as `0x${string}` | undefined;
      if (first && !resolveCircleExecutorAddress()) {
        saveCircleConfig({ executorAddress: first, chain });
      }
      ensureCircleExecutor();
      res.json({
        ok: true,
        email: savedEmail ?? result.email,
        message: result.message,
        wallets,
        executorAddress: ensureCircleExecutor() ?? resolveCircleExecutorAddress(),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Login verify failed",
        needsNewCode: true,
      });
    }
  });

  app.post("/api/circle/logout", (_req, res) => {
    try {
      const result = circleLogout();
      if (!result?.ok) {
        res.status(500).json({ error: result?.error ?? "Logout failed" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Logout failed" });
    }
  });

  app.get("/api/circle/wallets", (_req, res) => {
    if (!circleCliLoggedIn()) {
      res.status(401).json({ error: "Not logged in to Circle CLI" });
      return;
    }
    const chain = resolveCircleChain();
    res.json({
      chain,
      wallets: circleListAgentWallets(chain),
      executorAddress: ensureCircleExecutor() ?? resolveCircleExecutorAddress(),
    });
  });

  app.post("/api/circle/executor", (req, res) => {
    const address = String(req.body?.address ?? "").trim();
    if (!address.startsWith("0x")) {
      res.status(400).json({ error: "address required" });
      return;
    }
    const cfg = saveCircleConfig({
      executorAddress: address as `0x${string}`,
      chain: (req.body?.chain as string) ?? resolveCircleChain(),
    });
    res.json({ ok: true, executorAddress: cfg.executorAddress, chain: cfg.chain });
  });

  app.get("/api/circle/gateway/balance", (req, res) => {
    try {
      const address = String(req.query.address ?? resolveCircleExecutorAddress() ?? "");
      if (!address.startsWith("0x")) {
        res.status(400).json({ error: "address required" });
        return;
      }
      if (!circleCliLoggedIn()) {
        res.status(401).json({ error: "Circle login required" });
        return;
      }
      scheduleGatewayBalanceRefresh(address);
      const cached = getGatewayBalanceForApi(address);
      if (cached != null) {
        res.json({ data: { total: cached, token: "USDC", address, cached: true } });
        return;
      }
      const chain = String(req.query.chain ?? resolveCircleChain());
      const bal = circleGatewayBalance(address, chain);
      if (!bal?.ok) {
        res.status(500).json({ error: bal?.error ?? "Balance lookup failed" });
        return;
      }
      try {
        res.json(JSON.parse(bal.raw ?? "{}"));
      } catch {
        res.json({ raw: bal.raw });
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Balance lookup failed" });
    }
  });

  console.log(`  core routes: Circle login · config (${PORT})`);
}
