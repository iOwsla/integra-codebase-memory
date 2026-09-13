import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packages = [
  "application",
  "core",
  "database",
  "indexer",
  "graph",
  "history",
  "search",
  "memory",
  "mcp-server",
  "plugin-sdk",
  "plugin-typescript",
  "shared",
  "test-utils",
];
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      packages.map((p) => [`@codememory/${p}`, resolve(`packages/${p}/src/index.ts`)]),
    ),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/fixtures/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
