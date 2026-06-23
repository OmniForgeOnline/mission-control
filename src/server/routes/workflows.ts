import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { parse as parseYaml } from "yaml";

import {
  DEFAULT_WORKFLOW_ID,
  listWorkflowSummaries,
  loadAllWorkflows,
  loadWorkflow,
  resetWorkflowCache,
  serializeWorkflow,
  syncWorkflowFiles,
  validateWorkflow,
  workflowFilePath,
  type WorkflowDefinition
} from "../../core/workflows/index.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a typed workflow definition by round-tripping it through the exact
 * YAML that will be written. validateWorkflow consumes the snake_case YAML
 * document form (modifies_repo, join_policy, merge_request_*), so this ensures
 * the bytes on disk are valid and no field is silently dropped.
 */
function persistWorkflow(root: string, def: WorkflowDefinition): Promise<WorkflowDefinition> {
  const text = serializeWorkflow(def);
  const validated = validateWorkflow(parseYaml(text));
  const file = workflowFilePath(root, validated.id);
  return mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(file, text, "utf8"))
    .then(() => {
      resetWorkflowCache();
      return validated;
    });
}

export function createWorkflowsRouter(options: ServerOptions): Router {
  const router = Router();

  router.get(
    "/workflows",
    asyncRoute(async (_req, res) => {
      res.json(await listWorkflowSummaries(options.root));
    })
  );

  router.get(
    "/workflows/:id",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      try {
        res.json(await loadWorkflow(options.root, id));
      } catch {
        res.status(404).json({ error: `Unknown workflow: ${id}` });
      }
    })
  );

  router.post(
    "/workflows/sync",
    asyncRoute(async (_req, res) => {
      try {
        const synced = await syncWorkflowFiles(options.root);
        res.json({ synced, workflows: await listWorkflowSummaries(options.root) });
      } catch (error) {
        res.status(400).json({ error: errorMessage(error) });
      }
    })
  );

  router.post(
    "/workflows/validate",
    asyncRoute(async (req, res) => {
      try {
        const validated = validateWorkflow(
          parseYaml(serializeWorkflow(req.body as WorkflowDefinition))
        );
        res.json({ valid: true, workflow: validated });
      } catch (error) {
        res.status(400).json({ valid: false, error: errorMessage(error) });
      }
    })
  );

  router.post(
    "/workflows/serialize",
    asyncRoute(async (req, res) => {
      try {
        res.json({ yaml: serializeWorkflow(req.body as WorkflowDefinition) });
      } catch (error) {
        res.status(400).json({ error: errorMessage(error) });
      }
    })
  );

  router.post(
    "/workflows/parse",
    asyncRoute(async (req, res) => {
      const text = (req.body as { yaml?: string }).yaml ?? "";
      try {
        res.json({ workflow: validateWorkflow(parseYaml(text)) });
      } catch (error) {
        res.status(400).json({ error: errorMessage(error) });
      }
    })
  );

  router.post(
    "/workflows",
    asyncRoute(async (req, res) => {
      const def = req.body as WorkflowDefinition;
      const existing = await loadAllWorkflows(options.root);
      if (def.id && existing.has(def.id)) {
        res.status(409).json({ error: `Workflow already exists: ${def.id}` });
        return;
      }
      try {
        res.status(201).json(await persistWorkflow(options.root, def));
      } catch (error) {
        res.status(400).json({ error: errorMessage(error) });
      }
    })
  );

  router.put(
    "/workflows/:id",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const def = req.body as WorkflowDefinition;
      if (def.id !== id) {
        res.status(400).json({ error: "Workflow id in body must match the route id." });
        return;
      }
      const existing = await loadAllWorkflows(options.root);
      if (!existing.has(id)) {
        res.status(404).json({ error: `Unknown workflow: ${id}` });
        return;
      }
      try {
        res.status(200).json(await persistWorkflow(options.root, def));
      } catch (error) {
        res.status(400).json({ error: errorMessage(error) });
      }
    })
  );

  router.delete(
    "/workflows/:id",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      if (id === DEFAULT_WORKFLOW_ID) {
        res.status(400).json({ error: `Default workflow "${id}" cannot be deleted.` });
        return;
      }
      const existing = await loadAllWorkflows(options.root);
      if (!existing.has(id)) {
        res.status(404).json({ error: `Unknown workflow: ${id}` });
        return;
      }
      await rm(workflowFilePath(options.root, id), { force: true });
      resetWorkflowCache();
      res.status(204).end();
    })
  );

  return router;
}
