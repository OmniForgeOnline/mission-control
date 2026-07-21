import express from "express";
import path from "node:path";

import { setConnectorVault } from "../connectors/vault/index.ts";
import { generateShutdownToken, verifyShutdownToken } from "./control.ts";
import { subscribeStateEvents } from "./events.ts";
import { beginShutdown, runShutdownTeardown } from "./lifecycle.ts";
import { createAutonomyRouter } from "./routes/autonomy.ts";
import { createAgentConfigRouter } from "./routes/agent-config.ts";
import { createAttachmentsRouter } from "./routes/attachments.ts";
import { createConnectorsRouter } from "./routes/connectors.ts";
import { createIntakeRouter } from "./routes/intake.ts";
import { createMemoryRouter } from "./routes/memory.ts";
import { createProposalsRouter } from "./routes/proposals.ts";
import { createProjectsRouter } from "./routes/projects.ts";
import { createRunsRouter } from "./routes/runs.ts";
import { createRuntimeAssetsRouter } from "./routes/runtime-assets.ts";
import { createSettingsRouter } from "./routes/settings.ts";
import { createTasksRouter } from "./routes/tasks.ts";
import { createVersionRouter } from "./routes/version.ts";
import { createWorkflowsRouter } from "./routes/workflows.ts";
import { createTerminalRouter } from "./routes/terminal.ts";
import type { ServerOptions } from "./routes/helpers.ts";

export type { ServerOptions } from "./routes/helpers.ts";

export function createServer(options: ServerOptions): express.Express {
  const app = express();
  const staticDir = options.staticDir ?? path.resolve(process.cwd(), "dist", "ui");
  if (options.vault) {
    setConnectorVault(options.vault);
  }

  // Per-server shutdown token. Resolved once here so the /api/shutdown guard and
  // the /api/state boot payload (which the same-origin UI reads and echoes back)
  // can never diverge. Production (src/server/index.ts) passes it in so the
  // identical value is also written to server.json for the CLI; otherwise one is
  // generated so the route is always authenticated, even in tests.
  const shutdownToken = options.shutdownToken ?? generateShutdownToken();
  const settingsOptions: ServerOptions = { ...options, shutdownToken };

  // Attachments are uploaded as base64 JSON; allow a larger body only on that
  // path. Registered before the default parser, which skips bodies it has
  // already consumed, so other endpoints keep the 1mb ceiling.
  app.use("/api/attachments", express.json({ limit: "32mb" }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
    res.status(204).end();
  });
  app.use("/.well-known", (_req, res) => res.status(204).end());

  app.get("/api/events", (_req, res) => {
    subscribeStateEvents(res);
  });

  app.use("/api", createSettingsRouter(settingsOptions));
  app.use("/api", createAgentConfigRouter(options));
  app.use("/api", createAttachmentsRouter(options));
  app.use("/api", createIntakeRouter(options));
  app.use("/api", createTasksRouter(options));
  app.use("/api", createRunsRouter(options));
  app.use("/api", createMemoryRouter(options));
  app.use("/api", createAutonomyRouter(options));
  app.use("/api", createProposalsRouter(options));
  app.use("/api", createProjectsRouter(options));
  app.use("/api", createConnectorsRouter(options));
  app.use("/api", createWorkflowsRouter(options));
  app.use("/api", createRuntimeAssetsRouter(options));
  app.use("/api", createVersionRouter(options));
  app.use("/api", createTerminalRouter(options));

  app.post("/api/shutdown", (req, res) => {
    // Authenticate before any side effect: the caller must present this server's
    // shutdown token in a non-simple header. A browser-issued cross-site form
    // POST cannot set a custom header (and there is no CORS preflight that would
    // allow it), so the CSRF vector is closed. Without this check any reachable
    // caller could terminate every managed process.
    if (!verifyShutdownToken(req.get("x-shutdown-token"), shutdownToken)) {
      res.status(401).json({ error: "Shutdown not authorized." });
      return;
    }
    // Claim synchronously so concurrent requests (UI + CLI, or two CLI calls)
    // collapse into one teardown: only the first claimant wins, and a duplicate
    // request reports already:true instead of re-entering the escalating signal
    // path that force-exits. Shares the same teardown as Ctrl+C.
    const first = beginShutdown("api request");
    res.json({ shutting_down: true, already: !first });
    if (first) {
      // Defer so the response flushes before the server begins tearing down.
      setImmediate(() => {
        void runShutdownTeardown();
      });
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found" });
  });

  app.use(express.static(staticDir));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected error";
    res.status(400).json({ error: message });
  });

  return app;
}