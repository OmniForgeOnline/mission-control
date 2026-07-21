import path from "node:path";
import os from "node:os";
import { defineConfig } from "vitest/config";

import { INTEGRATION_TEST_GLOBS } from "./vitest.config.ts";

const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const maxWorkers = process.env.CI ? 2 : Math.min(8, Math.max(4, cpus - 1));

/**
 * Slow multi-turn daemon / git / replay coverage excluded from default `npm test`.
 * Run with: npm run test:integration
 *
 * Standalone config (not mergeConfig) so base `exclude` globs are not inherited.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@harness/core": path.resolve(__dirname, "src/core"),
      "@ui/app": path.resolve(__dirname, "src/ui/app"),
      "@ui/data": path.resolve(__dirname, "src/ui/data"),
      "@ui/shell": path.resolve(__dirname, "src/ui/shell"),
      "@ui/features": path.resolve(__dirname, "src/ui/features"),
      "@ui/shared": path.resolve(__dirname, "src/ui/shared"),
      "@ui/overlays": path.resolve(__dirname, "src/ui/overlays")
    }
  },
  test: {
    environment: "node",
    globals: true,
    testTimeout: 30_000,
    maxWorkers,
    restoreMocks: true,
    setupFiles: ["./tests/setup.ts"],
    include: [...INTEGRATION_TEST_GLOBS],
    exclude: ["**/node_modules/**", "**/dist/**", "**/data/**"]
  }
});
