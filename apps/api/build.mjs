#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import * as esbuild from "esbuild";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/server.mjs",
  packages: "external",
  logLevel: "info",
});

console.log("API bundle → dist/server.mjs");
