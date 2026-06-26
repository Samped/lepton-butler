import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { ARC_EIP155, resolveArcRpc } from "@butler/arc";
import { loadCoreRoutes } from "./load-core-routes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const WEB_URL = process.env.WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? 5174}`;
const SELLER = (process.env.BUTLER_SELLER_ADDRESS ?? "0x933a2405f84c224be1ef373ba16e992e1f459682") as `0x${string}`;

mkdirSync(resolve(__dirname, "../../../.data/circle-home"), { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

let ready = false;
let resolveRoutesReady!: () => void;
const routesReady = new Promise<void>((resolve) => {
  resolveRoutesReady = resolve;
});

/** Wait for route registration instead of failing mid-boot (login, policy, etc.). */
app.use((req, res, next) => {
  if (req.path === "/api/health") return next();
  void routesReady.then(() => next());
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: ready,
    mode: ready ? "live" : "starting",
    chain: ARC_EIP155,
    seller: SELLER,
    ...(ready ? { rpc: resolveArcRpc().replace(/\/\/[^@]+@/, "//***@") } : {}),
  });
});

app.listen(PORT, () => {
  console.log(`Butler API http://localhost:${PORT} (booting…)`);
  loadCoreRoutes(app);
  ready = true;
  resolveRoutesReady();
  console.log(`Butler API core ready · Circle login available`);
  void import("./load-routes.ts")
    .then(({ loadRoutes }) => {
      loadRoutes(app);
      console.log(`Butler API ready · dashboard: ${WEB_URL}`);
    })
    .catch((error) => {
      console.error("Butler API failed to load routes:", error);
      process.exit(1);
    });
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
});
