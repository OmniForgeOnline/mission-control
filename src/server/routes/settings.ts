import path from "node:path";
import { Router } from "express";

import { listAutonomyJobs } from "../../autonomy/jobs.ts";
import { attachAutonomyJobRuntime } from "../../autonomy/runtime.ts";
import { listProjects } from "../../core/projects/registry.ts";
import { listProjectJobs } from "../../core/projects/scoped-autonomy.ts";
import { loadStageAgentOverrides, setStageAgentOverride } from "../../core/agents/stage-agents.ts";
import { loadAgentConfig } from "../../core/agents/config/store.ts";
import { loadAllMergedExtensions } from "../../core/agents/extensions/launch.ts";
import { loadUsageSnapshots } from "../../core/agents/config/usage-store.ts";
import { getIntakeSession } from "../../core/intake/intake.ts";
import { ensureHarnessRepository } from "../../core/bootstrap/repository.ts";
import { loadHarnessSettings, updateHarnessSettings, type HarnessSettings } from "../../core/settings.ts";
import { completeTargets } from "../../core/paths/targets.ts";
import { DEFAULT_WORKFLOW_ID, listWorkflowSummaries, loadWorkflow, toWorkflowMetadata } from "../../core/workflows/index.ts";
import { loadConnectorsState } from "../../connectors/connections.ts";
import { listAllMemoryPages } from "../../memory/store.ts";
import { editorSummaries } from "../../core/editors/registry.ts";
import { listAllRuns } from "../../core/tasks/runs.ts";
import { listTasks } from "../../core/tasks/tasks.ts";
import { listInflightTaskIds } from "../../runtime/sessions.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

export function createSettingsRouter(options: ServerOptions): Router {
  const router = Router();

  router.get(
    "/state",
    asyncRoute(async (_req, res) => {
      await ensureHarnessRepository(options.root);
      const [tasks, runs, memoryPages, autonomyJobList, workflows, intakeSession, settings, agentConfig, agentUsageSnapshots, agentExtensions] =
        await Promise.all([
          listTasks(options.root),
          listAllRuns(options.root),
          listAllMemoryPages(options.root),
          listAutonomyJobs(options.root),
          listWorkflowSummaries(options.root),
          getIntakeSession(options.root),
          loadHarnessSettings(options.root),
          loadAgentConfig(options.root),
          loadUsageSnapshots(options.root),
          loadAllMergedExtensions(options.root, { testMode: options.testMode === true })
        ]);
      const agents = agentConfig.tools.map((tool) => ({
        id: tool.id,
        displayName: tool.displayName,
        supportsEffort: tool.supportsEffort,
        effortLevels: [...tool.effortLevels]
      }));
      const autonomyJobs = await attachAutonomyJobRuntime(options.root, autonomyJobList);

      // Add scope metadata to harness jobs
      const harnessJobs = autonomyJobs.map((job) => ({
        ...job,
        scope: "harness" as const
      }));

      // Load project jobs with scope metadata
      const projects = await listProjects(options.root);
      const projectJobsArrays = await Promise.all(
        projects.map(async (project) => {
          const jobs = await listProjectJobs(options.root, project.id);
          return jobs.map((job) => ({
            ...job,
            scope: "project" as const,
            scopeId: project.id,
            scopeLabel: project.name
          }));
        })
      );
      const projectJobs = projectJobsArrays.flat();

      // Combine harness and project jobs
      const autonomyJobsWithScope = [...harnessJobs, ...projectJobs];
      const defaultWorkflow = await loadWorkflow(options.root, DEFAULT_WORKFLOW_ID);
      res.json({
        root: options.root,
        // Per-server shutdown token for the same-origin UI, which echoes it back
        // in the x-shutdown-token header when the operator confirms shutdown.
        shutdownToken: options.shutdownToken ?? "",
        connectors: await loadConnectorsState(options.root),
        tasks,
        runs,
        memoryPages,
        autonomyJobs: autonomyJobsWithScope,
        projects,
        workflows,
        workflow: await toWorkflowMetadata(options.root, defaultWorkflow),
        stageAgentOverrides: (await loadStageAgentOverrides(options.root)).overrides,
        inflightTaskIds: listInflightTaskIds(),
        editors: editorSummaries(),
        activityThresholds: settings.activityThresholds,
        intakeSession,
        settings,
        agents,
        agentConfig,
        agentUsageSnapshots,
        agentExtensions
      });
    })
  );

  router.post(
    "/settings/stage-agents/:stage",
    asyncRoute(async (req, res) => {
      const stage = param(req.params["stage"], "stage");
      const agent = (req.body as { agent?: string }).agent;
      const config = await loadAgentConfig(options.root);
      if (!agent || !config.tools.some((tool) => tool.id === agent)) {
        res.status(400).json({ error: "agent must be a configured tool id." });
        return;
      }
      const updated = await setStageAgentOverride(options.root, stage, agent);
      res.json(updated);
    })
  );

  router.patch(
    "/settings",
    asyncRoute(async (req, res) => {
      const body = req.body as Partial<HarnessSettings>;
      if (body.defaultAgent !== undefined) {
        const config = await loadAgentConfig(options.root);
        if (!config.tools.some((tool) => tool.id === body.defaultAgent)) {
          res.status(400).json({ error: "defaultAgent must be a configured tool id." });
          return;
        }
      }
      if (body.theme !== undefined && !["dark", "light"].includes(body.theme)) {
        res.status(400).json({ error: "theme must be dark or light." });
        return;
      }
      if (body.projectsRoot !== undefined && typeof body.projectsRoot !== "string") {
        res.status(400).json({ error: "projectsRoot must be a string path." });
        return;
      }
      if (body.activityThresholds !== undefined) {
        const staleMs = Number(body.activityThresholds.staleMs);
        const longRunMs = Number(body.activityThresholds.longRunMs);
        if (!Number.isFinite(staleMs) || staleMs < 30_000 || !Number.isFinite(longRunMs) || longRunMs < 60_000) {
          res.status(400).json({ error: "activityThresholds must include staleMs (>=30s) and longRunMs (>=60s)." });
          return;
        }
      }
      res.json(await updateHarnessSettings(options.root, body));
    })
  );

  router.get(
    "/targets/complete",
    asyncRoute(async (req, res) => {
      const prefix = typeof req.query["prefix"] === "string" ? req.query["prefix"] : "";
      const settings = await loadHarnessSettings(options.root);
      res.json(
        await completeTargets(prefix, {
          homeRoot: options.homeRoot ?? settings.projectsRoot ?? process.env["HOME"],
          harnessRoot: options.root
        })
      );
    })
  );

  router.get(
    "/skills",
    asyncRoute(async (_req, res) => {
      const { listKernelSectionNames, listSkillsWithCategories } = await import("../../core/catalog/skills-catalog.ts");
      const [skills, kernelSections] = await Promise.all([
        listSkillsWithCategories(options.root),
        listKernelSectionNames(options.root)
      ]);
      res.json({ skills, kernelSections });
    })
  );

  router.get(
    "/skills/:name",
    asyncRoute(async (req, res) => {
      const { readSkill } = await import("../../core/catalog/skills-catalog.ts");
      const name = param(req.params["name"], "name");
      try {
        res.json(await readSkill(options.root, name));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Skill not found.";
        if (message === "Invalid skill name.") {
          res.status(400).json({ error: message });
          return;
        }
        res.status(404).json({ error: "Skill not found." });
      }
    })
  );

  router.put(
    "/skills/:name",
    asyncRoute(async (req, res) => {
      const { writeSkill } = await import("../../core/catalog/skills-catalog.ts");
      const name = param(req.params["name"], "name");
      const content = (req.body as { content?: unknown }).content;
      if (typeof content !== "string") {
        res.status(400).json({ error: "content must be a string." });
        return;
      }
      try {
        res.json(await writeSkill(options.root, name, content));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Skill not found.";
        if (message === "Invalid skill name.") {
          res.status(400).json({ error: message });
          return;
        }
        res.status(404).json({ error: "Skill not found." });
      }
    })
  );

  router.get(
    "/kernel/:section",
    asyncRoute(async (req, res) => {
      const { readFile } = await import("node:fs/promises");
      const section = param(req.params["section"], "section").replace(/[^a-z0-9-]/gi, "");
      try {
        const content = await readFile(path.join(options.root, "kernel", `${section}.md`), "utf8");
        res.json({ name: section, content });
      } catch {
        res.status(404).json({ error: "Section not found." });
      }
    })
  );

  return router;
}
