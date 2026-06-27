import type { Express } from "express";
import { getCircleLoginInitJob, startCircleLoginInitJob } from "./circle-login-jobs.ts";
import { getUserSessionPaths } from "./user-session.ts";

/** Minimal login routes — registered before heavy imports so init/verify respond immediately. */
export function registerCircleLoginRoutes(app: Express): void {
  app.post("/api/circle/login/init", (req, res) => {
    try {
      const email = String(req.body?.email ?? "").trim();
      if (!email.includes("@")) {
        res.status(400).json({ error: "Valid email required" });
        return;
      }
      const testnet = req.body?.testnet !== false;
      const sessionId = getUserSessionPaths()?.sessionId;
      const jobId = startCircleLoginInitJob(email, testnet, sessionId);
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
    const elapsedMs = Date.now() - job.startedAt;
    if (job.status === "pending") {
      res.json({ status: "pending", email: job.email, elapsedMs });
      return;
    }
    const result = job.result;
    if (!result?.ok) {
      res.json({ status: "error", error: result?.error ?? "Failed to send OTP", elapsedMs });
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
      elapsedMs,
    });
  });

  app.post("/api/circle/login/verify", (req, res) => {
    void handleLoginVerify(req, res);
  });
}

async function handleLoginVerify(
  req: { body?: Record<string, unknown> },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    json: (body: unknown) => void;
  }
): Promise<void> {
  try {
    const requestId = String(req.body?.requestId ?? "").trim();
    const otp = String(req.body?.otp ?? "").trim();
    if (!requestId || !otp) {
      res.status(400).json({ error: "requestId and otp required" });
      return;
    }
    const emailHint = String(req.body?.email ?? "").trim();
    const otpPrefixHint = String(req.body?.otpPrefix ?? "").trim();
    const testnet = req.body?.testnet !== false;
    const { circleLoginVerifyAsync, circleListAgentWallets, ensureCircleExecutor } = await import(
      "./circle-cli.ts"
    );
    const { saveCircleConfig, resolveCircleExecutorAddress, resolveCircleChain } = await import(
      "./circle-config.ts"
    );
    const verifyTimeout = process.env.RENDER || process.env.BUTLER_LITE_API ? 120_000 : 60_000;
    const result = await circleLoginVerifyAsync(
      requestId,
      otp,
      testnet,
      verifyTimeout,
      otpPrefixHint || undefined
    );
    if (!result?.ok) {
      const errMsg = result?.error ?? "Login failed";
      const rateLimited = /429|rate.?limit|too many requests|<!doctype/i.test(errMsg);
      res.status(rateLimited ? 429 : 401).json({
        error: errMsg,
        needsNewCode: result?.needsNewCode ?? rateLimited,
      });
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
    const executor = ensureCircleExecutor() ?? resolveCircleExecutorAddress();
    res.json({
      ok: true,
      email: savedEmail ?? result.email,
      message: result.message,
      wallets,
      executorAddress: executor,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Login verify failed",
      needsNewCode: true,
    });
  }
}
