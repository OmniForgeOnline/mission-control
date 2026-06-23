import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "./app.ts";
import { resolveListenHost } from "./bind-address.ts";
import { DEFAULT_HARNESS_ROOT, ensureHarnessRepository } from "../core/bootstrap/repository.ts";
import { ensureLoginShellEnvironment } from "../core/agents/resolver.ts";
import { getConnectorVault } from "../connectors/vault/index.ts";
import { loadAgentConfig } from "../core/agents/config/store.ts";
import { loadAllWorkflows } from "../core/workflows/index.ts";
import { ensureGrokMcp } from "../mcp/launcher.ts";
import { startDaemonLoop } from "../daemon/loop.ts";
import {
  reconcileInterruptedTasks,
  reconcileStuckPushedTasks
} from "../core/bootstrap/reconciliation.ts";

const root = process.env["HARNESS_ROOT"] ?? DEFAULT_HARNESS_ROOT;
// Package root: prefer a launcher-provided value (correct under any install layout,
// including the compiled dist/src/ tree), else derive from this module's location.
const packageRoot =
  process.env["HARNESS_PACKAGE_ROOT"] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const staticDir = path.join(packageRoot, "dist", "ui");
const host = resolveListenHost();
const port = Number(process.env["PORT"] ?? 4827);
const intervalMs = Number(process.env["HARNESS_DAEMON_INTERVAL_MS"] ?? 5000);
const autonomy = process.env["HARNESS_AUTONOMY"] !== "0";

ensureLoginShellEnvironment(root);
await ensureHarnessRepository(root);
// Materialize the connector vault with the resolved root so a file backend
// (the default off macOS) stores tokens under the right harness root.
getConnectorVault(root);
const agentConfig = await loadAgentConfig(root);
await loadAllWorkflows(root);
try {
  const grokTool = agentConfig.tools.find((tool) => tool.adapter === "grok" && tool.enabled);
  if (grokTool) {
    await ensureGrokMcp(root, grokTool.command);
  }
} catch (err) {
  console.warn(`Grok MCP setup skipped: ${(err as Error).message}`);
}

const reconciled = await reconcileInterruptedTasks(root);
if (reconciled.reconciled > 0) {
  console.log(`Reconciled ${reconciled.reconciled} interrupted task(s) from previous session.`);
}

const stuckPushed = await reconcileStuckPushedTasks(root);
if (stuckPushed.reconciled > 0) {
  console.log(`Reconciled ${stuckPushed.reconciled} stuck pushed task(s) on pre-review steps.`);
}

const app = createServer({ root, staticDir });

const uiIndex = path.join(staticDir, "index.html");
if (!existsSync(uiIndex)) {
  console.warn(
    `UI not built: ${uiIndex} not found.\n` +
      `The API is running, but the browser UI will be empty. Run './mc --build' and restart.`
  );
}

app.listen(port, host, () => {
  console.log(`OmniForge Mission Control running at http://${host}:${port}`);
  console.log(`UI served at: http://${host}:${port}`);
  console.log(`Mission Control root: ${root}`);
  console.log(`Daemon: in-process (every ${intervalMs}ms, autonomy=${autonomy ? "on" : "off"})`);
});

startDaemonLoop({ root, intervalMs, autonomy });

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    // Second signal: force exit immediately, no questions asked.
    process.exit(130);
  }
  shuttingDown = true;
  process.stdout.write(`\nReceived ${signal}, shutting down…\n`);

  // Force exit immediately. We don't try to be graceful because the event
  // loop may be blocked by an in-flight agent child process (awaiting its
  // exit). In that case, setTimeout callbacks and httpServer.close() callbacks
  // will never fire until the child exits. So we just exit now.
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
