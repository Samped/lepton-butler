import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ButlerResult } from "./butler.ts";

const JOBS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.data/butler-run-jobs");
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 240_000;

export type ButlerRunParams = {
  brief: string;
  apiBase: string;
  statePath: string;
  sellerAddress: string;
  strategy?: "auction" | "direct";
  category?: string;
  minReputation?: number;
  ttlSeconds?: number;
  qualityTier?: string;
  maxBudgetUsdc?: string;
  auctionMode?: "etf" | "single";
  forceX402?: boolean;
};

type ButlerRunJob = {
  status: "pending" | "running" | "ok" | "error";
  startedAt: number;
  params: ButlerRunParams;
  result?: ButlerResult;
  error?: string;
};

const jobs = new Map<string, ButlerRunJob>();

function jobPath(runId: string): string {
  return join(JOBS_DIR, `${runId}.json`);
}

function ensureJobsDir(): void {
  mkdirSync(JOBS_DIR, { recursive: true });
}

function saveJob(runId: string, job: ButlerRunJob): void {
  ensureJobsDir();
  jobs.set(runId, job);
  writeFileSync(jobPath(runId), JSON.stringify(job), "utf8");
}

function loadJobFromDisk(runId: string): ButlerRunJob | undefined {
  const path = jobPath(runId);
  if (!existsSync(path)) return undefined;
  try {
    const job = JSON.parse(readFileSync(path, "utf8")) as ButlerRunJob;
    if (Date.now() - job.startedAt > JOB_TTL_MS) {
      unlinkSync(path);
      return undefined;
    }
    jobs.set(runId, job);
    return job;
  } catch {
    return undefined;
  }
}

function updateJob(runId: string, patch: Partial<ButlerRunJob>): void {
  const job = jobs.get(runId) ?? loadJobFromDisk(runId);
  if (!job) return;
  Object.assign(job, patch);
  saveJob(runId, job);
}

function runWorker(runId: string, params: ButlerRunParams): void {
  void (async () => {
    updateJob(runId, { status: "running" });
    try {
      const { runButler } = await import("./butler.ts");
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Butler run timed out after 4 minutes")), RUN_TIMEOUT_MS);
      });
      const result = await Promise.race([runButler(params), timeout]);
      if (!result?.ok) {
        updateJob(runId, {
          status: "error",
          result,
          error: result?.error ?? "Butler returned no result",
        });
        return;
      }
      updateJob(runId, { status: "ok", result });
    } catch (error) {
      updateJob(runId, {
        status: "error",
        error: error instanceof Error ? error.message : "Butler failed",
      });
    }
  })();
}

export function startButlerRunJob(params: ButlerRunParams): string {
  const runId = randomUUID();
  saveJob(runId, { status: "pending", startedAt: Date.now(), params });
  setImmediate(() => runWorker(runId, params));
  return runId;
}

export function getButlerRunJob(runId: string): ButlerRunJob | undefined {
  return jobs.get(runId) ?? loadJobFromDisk(runId);
}

/** Drop stale run files on boot. */
export function pruneButlerRunJobs(): void {
  ensureJobsDir();
  const cutoff = Date.now() - JOB_TTL_MS;
  try {
    for (const name of readdirSync(JOBS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const runId = name.replace(/\.json$/, "");
      const job = loadJobFromDisk(runId);
      if (!job || job.startedAt < cutoff) {
        jobs.delete(runId);
        try {
          unlinkSync(jobPath(runId));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
