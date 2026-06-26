import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const BACKUP_DIR = resolve(ROOT, ".data/circle-login-sessions");

function circleHomeDir(): string {
  return process.env.CIRCLE_HOME?.trim() || resolve(ROOT, ".data", "circle-home");
}

export function loginRequestPath(requestId: string): string {
  return join(circleHomeDir(), ".circle", "login-requests", `${requestId}.json`);
}

function backupPath(requestId: string): string {
  return join(BACKUP_DIR, `${requestId}.json`);
}

/** Copy Circle CLI login-request file so verify survives Render restarts. */
export function backupLoginRequestSession(requestId: string): boolean {
  const src = loginRequestPath(requestId);
  if (!existsSync(src)) return false;
  mkdirSync(BACKUP_DIR, { recursive: true });
  copyFileSync(src, backupPath(requestId));
  return true;
}

/** Restore login-request session before verify if Circle home was wiped. */
export function restoreLoginRequestSession(requestId: string): boolean {
  const dest = loginRequestPath(requestId);
  if (existsSync(dest)) return true;
  const src = backupPath(requestId);
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return true;
}

export function hasLoginRequestSession(requestId: string): boolean {
  return existsSync(loginRequestPath(requestId)) || existsSync(backupPath(requestId));
}

export function readOtpHeadFromSession(requestId: string): string | undefined {
  for (const path of [loginRequestPath(requestId), backupPath(requestId)]) {
    if (!existsSync(path)) continue;
    try {
      const req = JSON.parse(readFileSync(path, "utf8")) as { otpHead?: string };
      if (typeof req.otpHead === "string" && req.otpHead.length >= 2) {
        return req.otpHead.toUpperCase();
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}
