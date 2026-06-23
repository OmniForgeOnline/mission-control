import path from "node:path";
import { defineConfig } from "vitest/config";

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
    restoreMocks: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/data/**"]
  }
});
