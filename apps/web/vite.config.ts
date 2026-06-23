import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: false },
  resolve: {
    dedupe: ["viem"],
    alias: [
      {
        find: "@butler/core/marketplace",
        replacement: resolve(root, "packages/core/src/marketplace.ts"),
      },
      {
        find: "@butler/core",
        replacement: resolve(root, "packages/core/src/index.ts"),
      },
      {
        find: "@butler/arc",
        replacement: resolve(root, "packages/arc/src/chain.ts"),
      },
    ],
  },
  optimizeDeps: {
    include: ["viem", "@butler/arc"],
    exclude: ["@butler/core"],
  },
});
