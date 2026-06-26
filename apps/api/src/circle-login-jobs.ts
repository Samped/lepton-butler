import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JOBS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.data/circle-login-jobs");

export type CircleLoginInitResult = {
  ok: boolean;
  requestId?: string;
  email?: string;
  message?: string;
  otpPrefix?: string;
  error?: string;
};

type LoginInitJob = {
  status: "pending" | "ok" | "error";
  email: string;
  testnet: boolean;
  result?: CircleLoginInitResult;
  startedAt: number;
};

const jobs = new Map<string, LoginInitJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

function jobPath(jobId: string): string {
  return join(JOBS_DIR, `${jobId}.json`);
}

function ensureJobsDir(): void {
  mkdirSync(JOBS_DIR, { recursive: true });
}

function saveJob(jobId: string, job: LoginInitJob): void {
  ensureJobsDir();
  jobs.set(jobId, job);
  writeFileSync(jobPath(jobId), JSON.stringify(job), "utf8");
}

function loadJobFromDisk(jobId: string): LoginInitJob | undefined {
  const path = jobPath(jobId);
  if (!existsSync(path)) return undefined;
  try {
    const job = JSON.parse(readFileSync(path, "utf8")) as LoginInitJob;
    if (Date.now() - job.startedAt > JOB_TTL_MS) {
      unlinkSync(path);
      return undefined;
    }
    jobs.set(jobId, job);
    return job;
  } catch {
    return undefined;
  }
}

function pruneJobs(): void {
  ensureJobsDir();
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) {
      jobs.delete(id);
      try {
        unlinkSync(jobPath(id));
      } catch {
        /* ignore */
      }
    }
  }
  try {
    for (const name of readdirSync(JOBS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const id = name.replace(/\.json$/, "");
      if (jobs.has(id)) continue;
      const job = loadJobFromDisk(id);
      if (job && job.startedAt < cutoff) {
        jobs.delete(id);
        unlinkSync(jobPath(id));
      }
    }
  } catch {
    /* ignore */
  }
}

function updateJob(jobId: string, patch: Partial<LoginInitJob>): void {
  const job = jobs.get(jobId) ?? loadJobFromDisk(jobId);
  if (!job) return;
  Object.assign(job, patch);
  saveJob(jobId, job);
}

function runLoginJob(jobId: string, email: string, testnet: boolean): void {
  void (async () => {
    try {
      const { circleCliInstalled, circleLoginInitAsync } = await import("./circle-cli.ts");
      if (!circleCliInstalled()) {
        fail(jobId, "Circle CLI not installed on the server. Redeploy the API on Render.");
        return;
      }
      const result = await circleLoginInitAsync(email, testnet, 120_000);
      if (result.ok && result.requestId) {
        const { backupLoginRequestSession } = await import("./circle-login-session.ts");
        backupLoginRequestSession(result.requestId);
      }
      updateJob(jobId, {
        status: result.ok ? "ok" : "error",
        result,
      });
    } catch (error) {
      fail(jobId, error instanceof Error ? error.message : "Failed to send OTP");
    }
  })();
}

/** Resume jobs interrupted by Render restarts (pending on disk, no in-memory worker). */
export function resumePendingLoginJobs(): void {
  ensureJobsDir();
  try {
    for (const name of readdirSync(JOBS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const jobId = name.replace(/\.json$/, "");
      const job = loadJobFromDisk(jobId);
      if (!job || job.status !== "pending") continue;
      const age = Date.now() - job.startedAt;
      if (age > 130_000) {
        fail(jobId, "Login was interrupted. Tap Send login code again.");
        continue;
      }
      if (age > 3_000 && !jobs.has(jobId)) {
        runLoginJob(jobId, job.email, job.testnet);
      }
    }
  } catch {
    /* ignore */
  }
}

export function startCircleLoginInitJob(email: string, testnet = true): string {
  pruneJobs();
  const jobId = randomUUID();
  saveJob(jobId, { status: "pending", email, testnet, startedAt: Date.now() });
  runLoginJob(jobId, email, testnet);
  return jobId;
}

function fail(jobId: string, error: string): void {
  updateJob(jobId, { status: "error", result: { ok: false, error } });
}

export function getCircleLoginInitJob(jobId: string): LoginInitJob | undefined {
  const cached = jobs.get(jobId);
  if (cached) return cached;
  return loadJobFromDisk(jobId);
}
