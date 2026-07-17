import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "./app.ts";
import { resolveListenHost } from "./bind-address.ts";
import { generateShutdownToken, removeServerInfo, resolveHarnessRoot, stopRunningServer, writeServerInfo } from "./control.ts";
import { gracefulShutdown, setShutdownTarget } from "./lifecycle.ts";
import { startListening } from "./listen.ts";
import { DEFAULT_HARNESS_ROOT, ensureHarnessRepository } from "../core/bootstrap/repository.ts";
import { ensureLoginShellEnvironment } from "../core/agents/resolver.ts";
import { attachTerminalWebSocketServer } from "../terminal/ws-server.ts";
import { disposeAllTerminalSessions, getTerminalSessionManager } from "../terminal/manager.ts";
import { getConnectorVault } from "../connectors/vault/index.ts";
import { loadAgentConfig } from "../core/agents/config/store.ts";
import { loadAllWorkflows } from "../core/workflows/index.ts";
import { ensureGrokMcp } from "../mcp/launcher.ts";
import { startDaemonLoop } from "../daemon/loop.ts";
import {
  reconcileInterruptedTasks,
  reconcileStuckPushedTasks
} from "../core/bootstrap/reconciliation.ts";

// CLI control commands run before any server boot. `stop` runs in a separate
// process and asks an already-running server to shut down via /api/shutdown.
const command = process.argv[2];
if (command === "stop" || command === "shutdown") {
  const outcome = await stopRunningServer(resolveHarnessRoot());
  console.log(outcome.message);
  process.exit(outcome.ok ? 0 : 1);
}

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

// Per-server shutdown token: required by /api/shutdown, written to server.json
// for `mission-control stop`, and delivered to the UI through /api/state. One
// value, generated once at boot, flows to all three carriers.
const shutdownToken = generateShutdownToken();
const app = createServer({ root, staticDir, packageRoot, shutdownToken });

const uiIndex = path.join(staticDir, "index.html");
if (!existsSync(uiIndex)) {
  console.warn(
    `UI not built: ${uiIndex} not found.\n` +
      `The API is running, but the browser UI will be empty. Run './mc --build' and restart.`
  );
}

// Bind before anything that assumes we're the live server. A second startup
// against an already-owned port fails the bind here (EADDRINUSE) and aborts
// before the daemon starts or server.json is written, so it can never overwrite
// the running server's pid/token and strand it beyond `mission-control stop`.
const server = await startListening(app, port, host);

// Interactive terminal sessions (xterm.js clients attach via WebSocket).
// Failures to load node-pty are logged but do not block the API/UI.
try {
  attachTerminalWebSocketServer(server, {
    manager: getTerminalSessionManager(),
    listenHost: host,
    authToken: shutdownToken
  });
} catch (err) {
  console.warn(
    `Interactive terminal disabled: ${err instanceof Error ? err.message : String(err)}`
  );
}

console.log(`OmniForge Mission Control running at http://${host}:${port}`);
console.log(`UI served at: http://${host}:${port}`);
console.log(`Mission Control root: ${root}`);
console.log(`Daemon: in-process (every ${intervalMs}ms, autonomy=${autonomy ? "on" : "off"})`);
console.log(`Stop with Ctrl+C, the UI shutdown button, or: mission-control stop`);

// Register the live server + daemon with the shared shutdown path (used by the
// signal handlers below and by the /api/shutdown route in app.ts) and record
// our pid/port so `mission-control stop` can reach us.
const daemonHandle = startDaemonLoop({ root, intervalMs, autonomy });
setShutdownTarget({
  server,
  daemon: daemonHandle,
  onShutdown: async () => {
    disposeAllTerminalSessions();
    await removeServerInfo(root);
  }
});
await writeServerInfo(root, { pid: process.pid, port, host, startedAt: new Date().toISOString(), shutdownToken });

// Every entry point shares one graceful path: terminate running agent
// processes, stop the daemon, close the server, then exit.
const shutdown = (signal: NodeJS.Signals): void => {
  void gracefulShutdown(signal);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
