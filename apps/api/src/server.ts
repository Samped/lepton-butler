import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { ARC_EIP155 } from "@butler/arc";
import { registerCircleLoginRoutes } from "./circle-login-routes.ts";
import { resumePendingLoginJobs } from "./circle-login-jobs.ts";
import { userSessionMiddleware } from "./user-session.ts";
import { getRouteLoaderStatus } from "./route-loader-status.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

/** Render free tier: skip heavy x402/marketplace unless explicitly disabled. */
if (process.env.RENDER === "true" && process.env.BUTLER_LITE_API == null) {
  process.env.BUTLER_LITE_API = "true";
}

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const WEB_URL = process.env.WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? 5174}`;
const SELLER = (process.env.BUTLER_SELLER_ADDRESS ?? "0x933a2405f84c224be1ef373ba16e992e1f459682") as `0x${string}`;

mkdirSync(resolve(__dirname, "../../../.data/circle-home"), { recursive: true });

const app = express();

let ready = false;
let taskRoutesReady = false;
let resolveRoutesReady!: () => void;
const routesReady = new Promise<void>((resolve) => {
  resolveRoutesReady = resolve;
});

/** Liveness probe — registered first; no RPC calls that can hang. */
app.get("/api/health", (_req, res) => {
  const loader = getRouteLoaderStatus();
  res.json({
    ok: ready && taskRoutesReady,
    mode: !ready ? "starting" : !taskRoutesReady ? "loading" : "live",
    chain: ARC_EIP155,
    seller: SELLER,
    executeRoutes: loader.executeRoutes,
    internalAgentPay: loader.internalAgentPay,
    ...(loader.executeLoadError ? { executeLoadError: loader.executeLoadError } : {}),
  });
});

app.use(
  cors({
    allowedHeaders: ["Content-Type", "Authorization", "X-Butler-Session"],
  })
);
app.use(express.json());
app.use(userSessionMiddleware);

/** Login routes — never blocked by heavy route imports. */
registerCircleLoginRoutes(app);

/** Boot-time probe — static path, no async route bundle (diagnostics). */
app.get("/api/marketplace/agents/research-agent/execute-probe", (_req, res) => {
  res.status(402).json({ probe: true, source: "server-boot" });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Butler API</title>
<style>body{font-family:system-ui,sans-serif;background:#06080d;color:#e8eef8;max-width:520px;margin:2rem auto;padding:0 1rem;line-height:1.5}
a{color:#34d399}code{background:#121820;padding:.15rem .4rem;border-radius:4px;font-size:.9em}
ul{padding-left:1.2rem}</style></head>
<body>
<h1>Butler API</h1>
<p>Backend for the Lepton Butler dashboard (Circle x402 payer). This host has no web UI at <code>/automate</code> — open the dashboard instead.</p>
<p><a href="${WEB_URL}">Open dashboard →</a></p>
<ul>
<li><a href="/api/health">/api/health</a></li>
<li><code>POST /api/circle/login/init</code> — send OTP</li>
</ul>
</body></html>`);
});

app.use((req, res, next) => {
  if (
    req.path === "/api/health" ||
    req.path === "/" ||
    req.path.startsWith("/api/circle/login") ||
    req.path === "/api/marketplace/agents/research-agent/execute-probe"
  ) {
    return next();
  }
  void routesReady.then(() => next());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Butler API http://localhost:${PORT} (booting…)`);
  ready = true;
  resumePendingLoginJobs();
  console.log(`Butler API login ready · Circle OTP`);

  void import("./load-core-routes.ts")
    .then(({ loadCoreRoutes }) => {
      loadCoreRoutes(app);
      console.log(`Butler API core ready · Circle status + config`);
    })
    .catch((error) => {
      console.error("Butler API failed to load core routes:", error);
    });

  const markTaskRoutesReady = () => {
    taskRoutesReady = true;
    resolveRoutesReady();
  };

  setImmediate(() => {
    if (process.env.BUTLER_LITE_API === "true") {
      void import("./load-task-routes.ts")
        .then(({ loadTaskRoutes }) => loadTaskRoutes(app))
        .then(() => {
          markTaskRoutesReady();
          console.log("Butler API lite mode — task routes loaded (full marketplace: BUTLER_LITE_API=false)");
        })
        .catch((error) => {
          console.error("Butler API failed to load task routes:", error);
          markTaskRoutesReady();
        });
      return;
    }
    void import("./load-routes.ts")
      .then(({ loadRoutes }) => loadRoutes(app))
      .then(() => {
        markTaskRoutesReady();
        console.log(`Butler API ready · dashboard: ${WEB_URL}`);
      })
      .catch((error) => {
        console.error("Butler API failed to load heavy routes (login still works):", error);
        markTaskRoutesReady();
      });
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
});
