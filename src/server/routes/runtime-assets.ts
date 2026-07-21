import { Router } from "express";

import {
  diffRuntimeAsset,
  inspectRuntimeAssets,
  keepRuntimeAsset,
  migrateRuntimeAssets,
  readRuntimeAssetsManifest,
  resetRuntimeAsset,
  type RuntimeAssetKind
} from "../../core/bootstrap/runtime-assets/index.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseAssetKind(value: string): RuntimeAssetKind {
  if (value === "workflow" || value === "skill") return value;
  throw new Error(`Unknown runtime asset kind: ${value}`);
}

export function createRuntimeAssetsRouter(options: ServerOptions): Router {
  const router = Router();

  router.get(
    "/runtime-assets",
    asyncRoute(async (_req, res) => {
      const [manifest, migration] = await Promise.all([
        readRuntimeAssetsManifest(options.root),
        inspectRuntimeAssets(options.root)
      ]);
      res.json({ manifest, migration });
    })
  );

  router.post(
    "/runtime-assets/migrate",
    asyncRoute(async (_req, res) => {
      res.json(await migrateRuntimeAssets(options.root));
    })
  );

  router.get(
    "/runtime-assets/:kind/:id/diff",
    asyncRoute(async (req, res) => {
      const kind = parseAssetKind(param(req.params["kind"], "kind"));
      const id = param(req.params["id"], "id");
      res.json(await diffRuntimeAsset(options.root, kind, id));
    })
  );

  router.post(
    "/runtime-assets/:kind/:id/keep",
    asyncRoute(async (req, res) => {
      const kind = parseAssetKind(param(req.params["kind"], "kind"));
      const id = param(req.params["id"], "id");
      try {
        res.json(await keepRuntimeAsset(options.root, kind, id));
      } catch (error) {
        res.status(400).json({ error: errorMessage(error) });
      }
    })
  );

  router.post(
    "/runtime-assets/:kind/:id/reset",
    asyncRoute(async (req, res) => {
      const kind = parseAssetKind(param(req.params["kind"], "kind"));
      const id = param(req.params["id"], "id");
      try {
        res.json(await resetRuntimeAsset(options.root, kind, id));
      } catch (error) {
        res.status(400).json({ error: errorMessage(error) });
      }
    })
  );

  return router;
}
