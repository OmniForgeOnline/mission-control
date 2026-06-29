import { Router } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readPackageMeta } from "../../core/system/version.ts";
import {
  applyUpdate,
  cancelIdleUpdate,
  getVersionStatus,
  hasQueuedIdleUpdate,
  queueIdleUpdate,
  readUpdateOutcome,
  stopAllWork,
  type ApplyContext
} from "../../core/system/update.ts";
import { asyncRoute, type ServerOptions } from "./helpers.ts";

/**
 * Derive the package root from this module's location as a last resort. Only
 * meaningful in the source tree; the server entry passes an explicit
 * `packageRoot` (correct under any install layout, including the bundled
 * dist/server.js where import.meta.url would be wrong).
 */
function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function createVersionRouter(options: ServerOptions): Router {
  const router = Router();

  function resolvePackageRoot(): string {
    return options.packageRoot ?? defaultPackageRoot();
  }

  function applyContext(packageRoot: string, packageName: string, fromVersion: string): ApplyContext {
    const ctx: ApplyContext = {
      root: options.root,
      packageRoot,
      packageName,
      fromVersion
    };
    if (options.updateSpawn) ctx.spawnUpdater = options.updateSpawn;
    if (options.updateExit) ctx.scheduleExit = options.updateExit;
    return ctx;
  }

  router.get(
    "/version",
    asyncRoute(async (_req, res) => {
      const packageRoot = resolvePackageRoot();
      const meta = await readPackageMeta(packageRoot);
      const status = await getVersionStatus({
        packageRoot,
        packageName: meta.name,
        installed: meta.version
      });
      res.json({ ...status, lastUpdate: await readUpdateOutcome(options.root) });
    })
  );

  router.post(
    "/update/apply",
    asyncRoute(async (req, res) => {
      const mode = (req.body as { mode?: unknown }).mode;
      if (mode !== "now" && mode !== "idle") {
        res.status(400).json({ error: "mode must be 'now' or 'idle'." });
        return;
      }

      const packageRoot = resolvePackageRoot();
      const meta = await readPackageMeta(packageRoot);
      if (!meta.name || !meta.version) {
        res.status(400).json({ error: "Could not read installed package metadata." });
        return;
      }

      const status = await getVersionStatus({
        packageRoot,
        packageName: meta.name,
        installed: meta.version
      });
      if (!status.canSelfUpdate) {
        res
          .status(409)
          .json({ error: "Automatic update is unavailable for this install. Update manually with npm." });
        return;
      }

      const ctx = applyContext(packageRoot, meta.name, meta.version);

      if (mode === "idle") {
        queueIdleUpdate(ctx);
        res.json({ queued: true, idleQueued: hasQueuedIdleUpdate() });
        return;
      }

      // mode === "now": stop active work, then hand off to the detached updater.
      cancelIdleUpdate();
      const stopped = await stopAllWork(options.root);
      const result = await applyUpdate(ctx);
      if (!result.spawned) {
        res
          .status(500)
          .json({ error: "Could not start the updater. The app is still running; retry or update manually." });
        return;
      }
      res.json({ applying: true, stopped });
    })
  );

  return router;
}
