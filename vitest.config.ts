import path from "node:path";
import os from "node:os";
import { defineConfig } from "vitest/config";

const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
// CI runners are ~2 vCPU; oversubscribing flakes and slows the suite. Locally use more workers.
const maxWorkers = process.env.CI ? 2 : Math.min(8, Math.max(4, cpus - 1));

/** Heavy multi-turn daemon/git/replay coverage — run via `npm run test:integration`. */
export const INTEGRATION_TEST_GLOBS = [
  "tests/workflow-daemon-*.test.ts",
  "tests/merge-request-step.test.ts",
  "tests/merge-tracking.test.ts",
  "tests/review-profiles-replay.test.ts",
  "tests/daemon-blocked-reason.test.ts"
] as const;

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
    // Integration tests drive real git worktrees/merges and multi-step daemon
    // turns; the slowest run ~5s on a fast dev machine and far longer on a
    // loaded/single-core CI, so a tight cap flakes under contention. 30s gives
    // the headroom those tests need without masking genuine hangs.
    testTimeout: 30_000,
    maxWorkers,
    restoreMocks: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/data/**",
      ...INTEGRATION_TEST_GLOBS
    ]
  }
});
