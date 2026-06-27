import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SESSIONS_DIR = resolve(ROOT, ".data/user-sessions");
const SESSION_HEADER = "x-butler-session";

/** UUID v4 — reject path traversal and malformed ids. */
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UserSessionPaths = {
  sessionId: string;
  circleHome: string;
  configPath: string;
};

const storage = new AsyncLocalStorage<{ sessionId: string }>();

export function parseSessionId(raw: unknown): string | null {
  const id = String(raw ?? "").trim();
  return SESSION_ID_RE.test(id) ? id : null;
}

export function sessionIdFromRequest(req: Request): string | null {
  return parseSessionId(req.headers[SESSION_HEADER]);
}

export function getUserSessionPaths(): UserSessionPaths | null {
  const ctx = storage.getStore();
  if (!ctx) return null;
  const base = join(SESSIONS_DIR, ctx.sessionId);
  return {
    sessionId: ctx.sessionId,
    circleHome: join(base, "circle-home"),
    configPath: join(base, "circle-config.json"),
  };
}

export function runWithUserSession<T>(sessionId: string, fn: () => T): T {
  mkdirSync(join(SESSIONS_DIR, sessionId, "circle-home"), { recursive: true });
  return storage.run({ sessionId }, fn);
}

/** Attach per-browser Circle session from X-Butler-Session header. */
export function userSessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const sessionId = sessionIdFromRequest(req);
  if (sessionId) {
    runWithUserSession(sessionId, () => next());
    return;
  }
  next();
}

export function hasActiveUserSession(): boolean {
  return !!storage.getStore();
}
