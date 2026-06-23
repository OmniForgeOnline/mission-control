import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { getIntakeSession } from "../src/core/intake/intake.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  DEFAULT_HARNESS_SETTINGS,
  defaultProjectsRoot,
  expandSettingsPath,
  loadHarnessSettings,
  updateHarnessSettings
} from "../src/core/settings.ts";
import { resolveAgentForStep } from "../src/core/agents/stage-agents.ts";
import { createTask } from "../src/core/tasks/tasks.ts";
import { loadWorkflow, resetWorkflowCache, resolveStepEffort } from "../src/core/workflows/index.ts";
import { createServer } from "../src/server/app.ts";

describe("harness settings", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-settings-"));
    resetWorkflowCache();
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to grok and bundled monitoring values when settings file is missing", async () => {
    const settings = await loadHarnessSettings(root);
    expect(settings.defaultAgent).toBe("grok");
    expect(settings.theme).toBe("dark");
    expect(settings.activityThresholds.staleMs).toBe(DEFAULT_HARNESS_SETTINGS.activityThresholds.staleMs);
    expect(settings.projectsRoot).toBe(defaultProjectsRoot());
  });

  it("resolves projects root from env and tilde paths", async () => {
    const previous = process.env['HARNESS_PROJECTS_ROOT'];
    process.env['HARNESS_PROJECTS_ROOT'] = "/tmp/from-env";
    try {
      expect(defaultProjectsRoot()).toBe("/tmp/from-env");
    } finally {
      if (previous === undefined) delete process.env['HARNESS_PROJECTS_ROOT'];
      else process.env['HARNESS_PROJECTS_ROOT'] = previous;
    }

    expect(expandSettingsPath("~/workspace")).toBe(path.join(process.env['HOME'] ?? "", "workspace"));

    await updateHarnessSettings(root, { projectsRoot: "~/harness-projects" });
    const settings = await loadHarnessSettings(root);
    expect(settings.projectsRoot).toBe(path.join(process.env['HOME'] ?? "", "harness-projects"));
  });

  it("persists expanded settings updates", async () => {
    await updateHarnessSettings(root, {
      defaultAgent: "claude",
      theme: "light",
      projectsRoot: "/tmp/projects",
      activityThresholds: { staleMs: 120_000, longRunMs: 600_000 }
    });
    const settings = await loadHarnessSettings(root);
    expect(settings.defaultAgent).toBe("claude");
    expect(settings.theme).toBe("light");
    expect(settings.projectsRoot).toBe("/tmp/projects");
    expect(settings.activityThresholds).toEqual({ staleMs: 120_000, longRunMs: 600_000 });

    const raw = JSON.parse(await readFile(path.join(root, "data", "state", "settings.json"), "utf8"));
    expect(raw.theme).toBe("light");
  });

  it("uses defaultAgent only when step has no explicit agent or role default", async () => {
    expect(await resolveAgentForStep(root, "code-feature", "plan")).toBe("codex");
    await updateHarnessSettings(root, { defaultAgent: "codex" });
    expect(await resolveAgentForStep(root, "code-feature", "implement")).toBe("claude");
  });

  it("applies defaultAgent to intake sessions and new tasks", async () => {
    await updateHarnessSettings(root, { defaultAgent: "claude" });
    expect((await getIntakeSession(root)).agent).toBe("claude");
    expect(
      (
        await createTask(root, {
          title: "Test task",
          description: "Uses harness default agent.",
          source: "manual",
          links: []
        })
      ).agent
    ).toBe("claude");
  });

  it("exposes settings and activity thresholds via API", async () => {
    const app = createServer({ root, testMode: true });

    const initial = await request(app).get("/api/state").expect(200);
    expect(initial.body.settings.defaultAgent).toBe("grok");

    const updated = await request(app)
      .patch("/api/settings")
      .send({
        defaultAgent: "codex",
        theme: "light",
        projectsRoot: "/tmp/harness-projects",
        activityThresholds: { staleMs: 180_000, longRunMs: 900_000 }
      })
      .expect(200);
    expect(updated.body.defaultAgent).toBe("codex");
    expect(updated.body.theme).toBe("light");

    const state = await request(app).get("/api/state").expect(200);
    expect(state.body.settings.defaultAgent).toBe("codex");
    expect(state.body.activityThresholds.staleMs).toBe(180_000);
  });

  it("rejects invalid settings values", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).patch("/api/settings").send({ defaultAgent: "invalid" }).expect(400);
    await request(app).patch("/api/settings").send({ theme: "sepia" }).expect(400);
    await request(app)
      .patch("/api/settings")
      .send({ activityThresholds: { staleMs: 1000, longRunMs: 1000 } })
      .expect(400);
  });
});

describe("workflow effort defaults", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-workflow-effort-"));
    resetWorkflowCache();
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("resolveStepEffort returns a step's declared effort, and undefined for unknown steps", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    expect(resolveStepEffort(workflow, "plan")).toBe(workflow.steps["plan"]?.effort);
    expect(resolveStepEffort(workflow, "implement")).toBe(workflow.steps["implement"]?.effort);
    expect(resolveStepEffort(workflow, "no-such-step")).toBeUndefined();
  });
});