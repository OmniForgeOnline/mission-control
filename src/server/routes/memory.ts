import { Router } from "express";

import { buildMemoryIndex, removeMemoryDocument, searchMemoryIndex } from "../../memory/index.ts";
import { captureMemoryPage, deleteMemoryPage, getMemoryPage, listMemoryPages } from "../../memory/store.ts";
import { loadHarnessSettings } from "../../core/settings.ts";
import type { MemoryPageInput } from "../../memory/store.ts";
import { asyncRoute, type ServerOptions } from "./helpers.ts";

/** Resolve the required project scope for a memory request, or null when absent. */
function memoryProjectId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createMemoryRouter(options: ServerOptions): Router {
  const router = Router();

  router.get(
    "/memory/pages",
    asyncRoute(async (req, res) => {
      const projectId = memoryProjectId(req.query["projectId"]);
      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }
      res.json(await listMemoryPages(options.root, projectId));
    })
  );

  router.post(
    "/memory/pages",
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as MemoryPageInput & { projectId?: string };
      const projectId = memoryProjectId(body.projectId);
      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }
      res.status(201).json(await captureMemoryPage(options.root, projectId, body));
    })
  );

  router.post(
    "/memory/index/rebuild",
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { targetPaths?: string[]; projectId?: string };
      const projectId = memoryProjectId(body.projectId);
      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }
      const settings = await loadHarnessSettings(options.root);
      res.json(
        await buildMemoryIndex(options.root, projectId, {
          homeRoot: options.homeRoot ?? settings.projectsRoot ?? process.env["HOME"],
          targetPaths: Array.isArray(body.targetPaths) ? body.targetPaths : []
        })
      );
    })
  );

  router.get(
    "/memory/index/search",
    asyncRoute(async (req, res) => {
      const projectId = memoryProjectId(req.query["projectId"]);
      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }
      const query = typeof req.query["q"] === "string" ? req.query["q"] : "";
      res.json(await searchMemoryIndex(options.root, projectId, query));
    })
  );

  router.get(
    /^\/memory\/pages\/(.+)$/,
    asyncRoute(async (req, res) => {
      const projectId = memoryProjectId(req.query["projectId"]);
      const encodedSlug = (req.params as Record<string, string>)["0"];
      if (!projectId || !encodedSlug) {
        res.status(400).json({ error: "projectId and slug are required." });
        return;
      }
      res.json(await getMemoryPage(options.root, projectId, decodeURIComponent(encodedSlug)));
    })
  );

  router.delete(
    /^\/memory\/pages\/(.+)$/,
    asyncRoute(async (req, res) => {
      const projectId = memoryProjectId(req.query["projectId"]);
      const encodedSlug = (req.params as Record<string, string>)["0"];
      if (!projectId || !encodedSlug) {
        res.status(400).json({ error: "projectId and slug are required." });
        return;
      }
      const slug = decodeURIComponent(encodedSlug);
      const removed = await deleteMemoryPage(options.root, projectId, slug);
      if (!removed) {
        res.status(404).json({ error: "Memory page not found" });
        return;
      }
      await removeMemoryDocument(options.root, projectId, slug);
      res.status(204).end();
    })
  );

  return router;
}
