#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import * as esbuild from "esbuild";

mkdirSync("dist", { recursive: true });

/** Bundle workspace TS; keep npm packages external so Node resolves them from node_modules. */
await esbuild.build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/server.mjs",
  external: [
    "express",
    "cors",
    "dotenv",
    "@circle-fin/x402-batching",
    "@x402/core",
    "@x402/evm",
    "viem",
  ],
  logLevel: "info",
});

console.log("API bundle → dist/server.mjs");
