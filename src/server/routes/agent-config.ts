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
import { discoverAllExtensions, discoverExtensionsForTool } from "../../core/agents/extensions/discover.ts";
import {
  extensionIdForInstalledPlugin,
  installMarketplacePlugin,
  parsePluginSource
} from "../../core/agents/extensions/install.ts";
import { loadMergedExtensions } from "../../core/agents/extensions/launch.ts";
import {
  loadExtensionRegistry,
  removeExtension,
  replaceDiscoveredExtensions,
  upsertExtension
} from "../../core/agents/extensions/store.ts";
import { mergeRegistryWithDiscovery } from "../../core/agents/extensions/resolve.ts";
import { normalizeExtension } from "../../core/agents/extensions/normalize.ts";
import { probeAgentRuntime } from "../../core/agents/runtime/probe.ts";
import {
  defaultUsageProviderDeps,
  mapCodexModels,
  type UsageProviderDeps
} from "../../core/agents/config/usage-providers.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

export function createAgentConfigRouter(options: ServerOptions): Router {
  const router = Router();

  // In tests, don't spawn real provider processes or hit the network.
  const noopUsageDeps: UsageProviderDeps = {
    fetchCodexRateLimits: async () => null,
    fetchCodexModels: async () => null,
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

  router.post(
    "/agent-config/models/discover",
    asyncRoute(async (req, res) => {
      const toolId = param((req.body as { toolId?: string }).toolId, "toolId");
      const config = await loadAgentConfig(options.root);
      const tool = config.tools.find((t) => t.id === toolId);
      if (!tool) {
        res.status(404).json({ error: `Unknown tool "${toolId}".` });
        return;
      }
      // Discovery is wired for codex (app-server model/list). Other tools don't
      // expose a model list; the operator adds those by hand via the pools API.
      if (tool.id !== "codex") {
        res
          .status(400)
          .json({ error: `Model discovery is not supported for "${toolId}". Add models manually.` });
        return;
      }
      try {
        const models = mapCodexModels(await usageDeps.fetchCodexModels(tool.command, options.root));
        let bundle = config;
        for (const model of models) {
          bundle = await upsertModelPool(options.root, {
            id: model.id,
            toolId,
            displayName: model.displayName,
            modelArgs: ["--model", model.id],
            modelEnv: {},
            capabilities: ["author", "reviewer", "code", "plan", "review"],
            qualityWeight: 50,
            tier: "paid",
            usage: { kind: "usage-only" },
            usageSource: "codex-app-server",
            enabled: true,
            builtin: false
          });
        }
        res.json({ config: bundle, discovered: models.length });
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : "Model discovery failed." });
      }
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

  router.get(
    "/agent-config/extensions",
    asyncRoute(async (_req, res) => {
      const [registry, config] = await Promise.all([
        loadExtensionRegistry(options.root),
        loadAgentConfig(options.root)
      ]);
      const merged = await Promise.all(
        config.tools
          .filter((tool) => tool.enabled)
          .map(async (tool) => ({
            toolId: tool.id,
            extensions: await loadMergedExtensions(options.root, tool.id)
          }))
      );
      res.json({ registry, tools: merged });
    })
  );

  router.post(
    "/agent-config/extensions/discover",
    asyncRoute(async (_req, res) => {
      const config = await loadAgentConfig(options.root);
      const results = options.testMode
        ? []
        : await discoverAllExtensions(config.tools);
      const discovered = results.flatMap((result) =>
        mergeRegistryWithDiscovery([], result.discovered).map((entry) => ({
          ...entry,
          toolId: result.toolId
        }))
      );
      const registry = await replaceDiscoveredExtensions(
        options.root,
        discovered,
        new Date().toISOString()
      );
      res.json({ registry, results });
    })
  );

  router.put(
    "/agent-config/extensions",
    asyncRoute(async (req, res) => {
      const registry = await upsertExtension(options.root, normalizeExtension(req.body));
      res.json({ registry });
    })
  );

  router.post(
    "/agent-config/extensions/install",
    asyncRoute(async (req, res) => {
      const body = req.body as {
        toolId?: string;
        source?: string;
        marketplace?: string;
        marketplaceSource?: string;
        confirmed?: boolean;
      };
      if (!body.confirmed) {
        res.status(400).json({ error: "Operator confirmation is required to install plugins." });
        return;
      }
      if (!body.toolId || !body.source?.trim()) {
        res.status(400).json({ error: "toolId and source are required." });
        return;
      }

      let installResult;
      if (options.testMode) {
        const parsed = parsePluginSource(body.source, body.marketplace);
        installResult = {
          command: "test-mode",
          stdout: "",
          plugin: parsed.plugin,
          marketplace: parsed.marketplace,
          selector: parsed.selector
        };
      } else {
        installResult = await installMarketplacePlugin(options.root, {
          toolId: body.toolId,
          source: body.source,
          ...(body.marketplace ? { marketplace: body.marketplace } : {}),
          ...(body.marketplaceSource ? { marketplaceSource: body.marketplaceSource } : {})
        });
      }

      const config = await loadAgentConfig(options.root);
      const tool = config.tools.find((entry) => entry.id === body.toolId);
      if (!tool) {
        res.status(400).json({ error: `Unknown tool "${body.toolId}".` });
        return;
      }

      const discovery = options.testMode
        ? { discovered: [], errors: [] as string[] }
        : await discoverExtensionsForTool(tool);
      const installedId = extensionIdForInstalledPlugin(body.toolId, installResult.selector);
      const discovered = mergeRegistryWithDiscovery([], discovery.discovered);
      if (!discovered.some((entry) => entry.id === installedId)) {
        discovered.push({
          id: installedId,
          toolId: body.toolId,
          kind: "plugin",
          displayName: installResult.plugin,
          source: installResult.selector,
          detectedFrom: "manual",
          defaultEnabled: false
        });
      }

      const registry = await replaceDiscoveredExtensions(
        options.root,
        discovered.map((entry) => ({
          ...entry,
          toolId: body.toolId as typeof entry.toolId
        })),
        new Date().toISOString()
      );

      res.json({ install: installResult, registry, discovery });
    })
  );

  router.delete(
    "/agent-config/extensions/:id",
    asyncRoute(async (req, res) => {
      const registry = await removeExtension(options.root, param(req.params["id"], "id"));
      res.json({ registry });
    })
  );

  return router;
}
