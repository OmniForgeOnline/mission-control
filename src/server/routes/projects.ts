import { Router } from "express";

import {
  getProject,
  listProjects,
  onboardProject,
  updateProject,
  removeProject
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
import {
  readProjectQualityGate,
  validateGateChecks,
  writeProjectQualityGateRun,
  writeQualityGate,
  type QualityGateCheck,
  type QualityGateFile
} from "../../core/projects/quality-gate.ts";
import {
  generateProjectQualityGate,
  startProjectQualityGate
} from "../../core/projects/quality-gate-generation.ts";
import { pickFolder } from "../../core/projects/folder-picker.ts";
import { runProjectGateChecks } from "../../core/projects/project-checks.ts";
import { repointProjectTasks } from "../../core/tasks/tasks.ts";
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
      // Tailor quick starts and generate a quality-gate config in the background
      // (read-only plan turns); the response does not wait on either. Skip both
      // in test mode so the suite never spawns real codex subprocesses that
      // outlive their temp dirs. Tests that need a generated config call the
      // /quickstarts/regenerate or /quality-gate/regenerate routes with a runner.
      const turns = turnOptions(options);
      if (!turns.wait) {
        startProjectQuickstarts(options.root, project, turns);
        // Await the `generating` write so a project-scoped check plan read issued
        // the moment onboarding responds never sees the `pending` baseline interim.
        await startProjectQualityGate(options.root, project, turns);
      }
      res.json(project);
    })
  );

  router.patch(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const body = req.body as { name?: string; status?: "active" | "paused"; repoPath?: string };
      const input: { name?: string; status?: "active" | "paused"; repoPath?: string } = {};
      if (body.name?.trim()) {
        input.name = body.name.trim();
      }
      if (body.status) {
        input.status = body.status;
      }
      if (body.repoPath !== undefined && body.repoPath.trim()) {
        input.repoPath = body.repoPath.trim();
      }

      // Capture the pre-update path so a repoint can cascade onto the project's
      // existing tasks. updateProject is the single source of truth for path
      // validation (git worktree, collisions, nesting).
      const before = await getProject(options.root, projectId);
      if (!before) {
        res.status(404).json({ error: `Project not found: ${projectId}` });
        return;
      }
      const project = await updateProject(options.root, projectId, input);
      if (project.repoPath !== before.repoPath) {
        await repointProjectTasks(options.root, projectId, before.repoPath, project.repoPath);
      }
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
      await startProjectQualityGate(options.root, project, opts);
      res.json(await readProjectQualityGate(options.root, projectId));
    })
  );

  router.post(
    "/projects/:id/quality-gate/run",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const project = await getProject(options.root, projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const body = req.body as { check?: unknown } | undefined;
      const checkName = typeof body?.check === "string" && body.check.trim() ? body.check.trim() : undefined;
      // Synchronous: each check has its own timeout, so a hung check can't block
      // forever. Run-all is bounded by N x per-check timeout; long suites simply
      // keep the request open until they finish.
      const summary = await runProjectGateChecks(options.root, projectId, project.repoPath, checkName);
      // Persist the last FULL run so the project self-improvement agent sees actual
      // pass/fail. Single-check spot checks are transient and don't overwrite it.
      if (!checkName) {
        await writeProjectQualityGateRun(options.root, projectId, {
          runAt: new Date().toISOString(),
          outcome: summary.outcome,
          pass: summary.pass,
          results: summary.results,
          repoPath: project.repoPath
        });
      }
      res.json(summary);
    })
  );

  router.put(
    "/projects/:id/quality-gate/checks",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params["id"], "id");
      const project = await getProject(options.root, projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const validation = validateGateChecks((req.body as { checks?: unknown } | undefined)?.checks);
      if (!validation.ok) {
        res.status(400).json({ error: "Invalid quality-gate checks.", details: validation.errors });
        return;
      }
      // Operator-curated checks override whatever the agent produced. The gate becomes
      // ready (or incomplete if all checks were removed); a later Regenerate overwrites
      // these edits with fresh agent output, which is the intended escape hatch.
      const current = await readProjectQualityGate(options.root, projectId);
      const checks = validation.checks as QualityGateCheck[];
      const updated: QualityGateFile = {
        status: checks.length > 0 ? "ready" : "incomplete",
        checks,
        rationale: checks.length > 0 ? "Operator-curated quality-gate checks." : "All checks removed.",
        repoPath: project.repoPath,
        generatedAt: new Date().toISOString(),
        ...(current.intel ? { intel: current.intel } : {}),
        ...(checks.length === 0 ? { needsResolution: ["All checks were removed. Add checks or Regenerate."] } : {})
      };
      await writeQualityGate(options.root, projectId, updated);
      res.json(updated);
    })
  );

  return router;
}
