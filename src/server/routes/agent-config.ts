import { Router } from "express";

import { ensureHarnessRepository } from "../../core/bootstrap/repository.ts";
import {
  loadAgentConfig,
  removeModelPool,
  removeTool,
  upsertModelPool,
  upsertRoutingProfile,
  upsertTool
} from "../../core/agents/config/store.ts";
import {
  normalizeModelPool,
  normalizeRoutingProfile,
  normalizeTool
} from "../../core/agents/config/normalize.ts";
import { loadUsageSnapshots } from "../../core/agents/config/usage-store.ts";
import { refreshUsageSnapshots } from "../../core/agents/config/usage-refresh.ts";
import { probeAgentRuntime } from "../../core/agents/runtime/probe.ts";
import {
  defaultUsageProviderDeps,
  type UsageProviderDeps
} from "../../core/agents/config/usage-providers.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

export function createAgentConfigRouter(options: ServerOptions): Router {
  const router = Router();

  // In tests, don't spawn real provider processes or hit the network.
  const noopUsageDeps: UsageProviderDeps = {
    fetchCodexRateLimits: async () => null,
    readClaudeOAuthToken: async () => null,
    fetchClaudeUsage: async () => ({})
  };
  const usageDeps = options.testMode ? noopUsageDeps : defaultUsageProviderDeps;

  router.get(
    "/agent-config",
    asyncRoute(async (_req, res) => {
      await ensureHarnessRepository(options.root);
      const [config, usage] = await Promise.all([
        loadAgentConfig(options.root),
        loadUsageSnapshots(options.root)
      ]);
      const runtimeDiagnostics =
        options.testMode
          ? {}
          : Object.fromEntries(
              await Promise.all(
                config.tools.map(async (tool) => {
                  const probe = await probeAgentRuntime(tool, { cwd: options.root });
                  return [tool.id, {
                    available: probe.available,
                    command: probe.command,
                    capabilities: probe.capabilities,
                    diagnostics: probe.diagnostics
                  }];
                })
              )
            );
      res.json({ config, usage, runtimeDiagnostics });
    })
  );

  router.put(
    "/agent-config/tools",
    asyncRoute(async (req, res) => {
      const config = await upsertTool(options.root, normalizeTool(req.body));
      res.json({ config });
    })
  );

  router.delete(
    "/agent-config/tools/:id",
    asyncRoute(async (req, res) => {
      const config = await removeTool(options.root, param(req.params["id"], "id"));
      res.json({ config });
    })
  );

  router.put(
    "/agent-config/pools",
    asyncRoute(async (req, res) => {
      const config = await upsertModelPool(options.root, normalizeModelPool(req.body));
      res.json({ config });
    })
  );

  router.delete(
    "/agent-config/pools/:id",
    asyncRoute(async (req, res) => {
      const config = await removeModelPool(options.root, param(req.params["id"], "id"));
      res.json({ config });
    })
  );

  router.put(
    "/agent-config/profiles",
    asyncRoute(async (req, res) => {
      const config = await upsertRoutingProfile(options.root, normalizeRoutingProfile(req.body));
      res.json({ config });
    })
  );

  router.post(
    "/agent-config/usage/refresh",
    asyncRoute(async (_req, res) => {
      const usage = await refreshUsageSnapshots(options.root, usageDeps);
      res.json({ usage });
    })
  );

  return router;
}
