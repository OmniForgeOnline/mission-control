import { Router } from "express";

import path from "node:path";

import {
  getProject,
  listProjects,
  onboardProject,
  updateProject,
  removeProject,
  projectDir
} from "../../core/projects/registry.ts";
import {
  setProjectJobRunMode,
  runProjectJob
} from "../../core/projects/scoped-autonomy.ts";
import {
  generateProjectQuickstarts,
  readProjectQuickstarts,
  startProjectQuickstarts
} from "../../core/projects/quickstarts.ts";
import { readProjectQualityGate } from "../../core/projects/quality-gate.ts";
import {
  generateProjectQualityGate,
  startProjectQualityGate
} from "../../core/projects/quality-gate-generation.ts";
import {
  computeProjectQualityGrades,
  type QualityFile
} from "../../core/quality/quality.ts";
import { readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import { pickFolder } from "../../core/projects/folder-picker.ts";
import {
  addIntakeMessage,
  confirmIntakeDraft,
  dismissIntakeDraft,
  getIntakeSession,
  resetIntakeSession,
  retryIntakeQueueItem,
  startIntakeQueue
} from "../../core/intake/intake.ts";
import { asyncRoute, asStringArray, param, turnOptions, type ServerOptions } from "./helpers.ts";
import type { AutonomyRunMode } from "../../autonomy/job-types.ts";
import type { IntakeScope } from "../../core/types.ts";

function projectScope(projectId: string): IntakeScope {
  return { kind: "project", projectId };
}

async function requireProject(root: string, projectId: string): Promise<void> {
  const project = await getProject(root, projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
}

export function createProjectsRouter(options: ServerOptions): Router {
  const router = Router();

  router.get(
    "/projects",
    asyncRoute(async (_req, res) => {
      res.json(await listProjects(options.root));
    })
  );

  router.post(
    "/projects/pick-folder",
    asyncRoute(async (_req, res) => {
      const result = await pickFolder();
      if ("unavailable" in result) {
        res.status(501).json({ error: "No native folder picker is available on this platform." });
        return;
      }
      if ("canceled" in result) {
        res.json({ canceled: true });
        return;
      }
      res.json({ path: result.path });
    })
  );

  router.post(
    "/projects",
    asyncRoute(async (req, res) => {
      const body = req.body as { repoPath?: string; name?: string };
      if (!body.repoPath?.trim()) {
        res.status(400).json({ error: "repoPath is required." });
        return;
      }
      const input: { repoPath: string; name?: string } = {
        repoPath: body.repoPath.trim()
      };
      if (body.name?.trim()) {
        input.name = body.name.trim();
      }
      const project = await onboardProject(options.root, input);
      // Tailor the quick starts to the repo in the background (read-only plan
      // turn); the response does not wait on it. The UI polls /quickstarts.
      startProjectQuickstarts(options.root, project, turnOptions(options));
      // Generate a project-specific quality-gate config in the background by
      // gathering repo intel; the UI polls /quality-gate.
      startProjectQualityGate(options.root, project, turnOptions(options));
      res.json(project);
    })
  );

  router.patch(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      const body = req.body as { name?: string; status?: "active" | "paused" };
      const input: { name?: string; status?: "active" | "paused" } = {};
      if (body.name?.trim()) {
        input.name = body.name.trim();
      }
      if (body.status) {
        input.status = body.status;
      }
      const project = await updateProject(options.root, param(req.params["id"], "id"), input);
      res.json(project);
    })
  );

  router.delete(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      await removeProject(options.root, param(req.params["id"], "id"));
      res.json({ deleted: true });
    })
  );

  router.get(
    "/projects/:id/intake/session",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      res.json(await getIntakeSession(options.root, projectScope(projectId)));
    })
  );

  router.post(
    "/projects/:id/intake/reset",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      res.json(await resetIntakeSession(options.root, projectScope(projectId)));
    })
  );

  router.post(
    "/projects/:id/intake/confirm",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      const turn = await confirmIntakeDraft(options.root, projectScope(projectId));
      res.status(201).json({ turn });
    })
  );

  router.post(
    "/projects/:id/intake/draft/dismiss",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      res.json(await dismissIntakeDraft(options.root, projectScope(projectId)));
    })
  );

  router.post(
    "/projects/:id/intake/messages",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      const scope = projectScope(projectId);
      const body = req.body as { body?: string; attachmentIds?: unknown };
      const attachmentIds = asStringArray(body.attachmentIds);
      const message = await addIntakeMessage(options.root, {
        author: "operator",
        body: body.body ?? "",
        ...(attachmentIds ? { attachmentIds } : {})
      }, scope);
      startIntakeQueue(options.root, { ...turnOptions(options), scope });
      res.status(202).json({ message, session: await getIntakeSession(options.root, scope) });
    })
  );

  router.post(
    "/projects/:id/intake/queue/:itemId/retry",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      const scope = projectScope(projectId);
      const itemId = param(req.params["itemId"], "itemId");
      const session = await retryIntakeQueueItem(options.root, scope, itemId, turnOptions(options));
      res.json({ session });
    })
  );

  router.post(
    "/projects/:id/jobs/:jobName/run",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const jobName = param(req.params["jobName"], "jobName");
      res.json(await runProjectJob(options.root, projectId, jobName));
    })
  );

  router.post(
    "/projects/:id/jobs/:jobName/run-mode",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const jobName = param(req.params["jobName"], "jobName");
      const body = req.body as { runMode?: AutonomyRunMode };
      res.json(
        await setProjectJobRunMode(options.root, projectId, jobName, body.runMode ?? "manual")
      );
    })
  );

  router.get(
    "/projects/:id/quickstarts",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      res.json(await readProjectQuickstarts(options.root, projectId));
    })
  );

  router.post(
    "/projects/:id/quickstarts/regenerate",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const project = await getProject(options.root, projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const opts = turnOptions(options);
      if (opts.wait) {
        res.json(await generateProjectQuickstarts(options.root, project, opts));
        return;
      }
      startProjectQuickstarts(options.root, project, opts);
      res.json(await readProjectQuickstarts(options.root, projectId));
    })
  );

  router.get(
    "/projects/:id/quality-gate",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      await requireProject(options.root, projectId);
      res.json(await readProjectQualityGate(options.root, projectId));
    })
  );

  router.post(
    "/projects/:id/quality-gate/regenerate",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const project = await getProject(options.root, projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const opts = turnOptions(options);
      if (opts.wait) {
        res.json(await generateProjectQualityGate(options.root, project, opts));
        return;
      }
      startProjectQualityGate(options.root, project, opts);
      res.json(await readProjectQualityGate(options.root, projectId));
    })
  );

  router.get(
    "/projects/:id/quality",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const project = await getProject(options.root, projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const filePath = path.join(projectDir(options.root, projectId), "quality.json");
      res.json(await readJsonFile<QualityFile>(filePath, { updatedAt: "", domains: {} }));
    })
  );

  router.post(
    "/projects/:id/quality/recompute",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const project = await getProject(options.root, projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const result = await computeProjectQualityGrades(options.root, project.repoPath);
      const filePath = path.join(projectDir(options.root, projectId), "quality.json");
      await writeJsonFile(filePath, result);
      res.json(result);
    })
  );

  return router;
}
