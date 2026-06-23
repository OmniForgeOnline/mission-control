import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  clearTaskStageEffortOverride,
  createTask,
  setTaskStageEffortOverride
} from "../src/core/tasks/tasks.ts";
import { effortForRunner, resolveStepEffort } from "../src/core/workflows/graph.ts";
import { loadWorkflow, resetWorkflowCache } from "../src/core/workflows/index.ts";
import { createServer } from "../src/server/app.ts";

describe("task stage effort", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-task-stage-effort-"));
    resetWorkflowCache();
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("persists per-task stage effort overrides", async () => {
    const task = await createTask(root, {
      title: "Override effort",
      description: "Task-specific stage effort.",
      source: "manual",
      links: []
    });
    const updated = await setTaskStageEffortOverride(root, task.id, "implement", "high");
    expect(updated.stageEffortOverrides).toEqual({ implement: "high" });
  });

  it("clears per-task stage effort overrides", async () => {
    const task = await createTask(root, {
      title: "Clear effort override",
      description: "Reset to task/workflow default.",
      source: "manual",
      links: []
    });
    await setTaskStageEffortOverride(root, task.id, "implement", "high");
    const cleared = await clearTaskStageEffortOverride(root, task.id, "implement");
    expect(cleared.stageEffortOverrides).toBeUndefined();
  });

  it("keeps other stage overrides when clearing one", async () => {
    const task = await createTask(root, {
      title: "Partial clear",
      description: "Two overrides, clear one.",
      source: "manual",
      links: []
    });
    await setTaskStageEffortOverride(root, task.id, "implement", "high");
    await setTaskStageEffortOverride(root, task.id, "plan", "low");
    const cleared = await clearTaskStageEffortOverride(root, task.id, "implement");
    expect(cleared.stageEffortOverrides).toEqual({ plan: "low" });
  });

  it("rejects overrides on steps that do not support effort", async () => {
    const task = await createTask(root, {
      title: "Terminal step",
      description: "Handoff is terminal — no effort.",
      source: "manual",
      links: []
    });
    await expect(setTaskStageEffortOverride(root, task.id, "handoff", "high")).rejects.toThrow(
      'Step "handoff" does not support effort.'
    );
  });

  it("rejects invalid effort levels", async () => {
    const task = await createTask(root, {
      title: "Bogus effort",
      description: "Not a real effort level.",
      source: "manual",
      links: []
    });
    await expect(
      // @ts-expect-error — deliberately invalid effort level
      setTaskStageEffortOverride(root, task.id, "implement", "turbo")
    ).rejects.toThrow(/invalid effort/i);
  });

  it("resolves effort precedence: stage override > task effort > step default", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const stepDefault = resolveStepEffort(workflow, "implement");

    // Stage override beats the task-level effort.
    expect(
      effortForRunner(workflow, "implement", { stageOverride: "max", taskEffort: "low" })
    ).toBe("max");
    // Task-level effort beats the workflow/step default.
    expect(effortForRunner(workflow, "implement", { taskEffort: "low" })).toBe("low");
    // Falls back to the step/workflow default when neither is set.
    expect(effortForRunner(workflow, "implement", {})).toBe(stepDefault);
  });

  it("exposes task stage effort override endpoints", async () => {
    const task = await createTask(root, {
      title: "API effort override",
      description: "Set via HTTP.",
      source: "manual",
      links: []
    });
    const app = createServer({ root });

    const setResponse = await request(app)
      .post(`/api/tasks/${task.id}/stage-effort/implement`)
      .send({ effort: "high" });
    expect(setResponse.status).toBe(200);
    expect(setResponse.body.stageEffortOverrides).toEqual({ implement: "high" });

    const clearResponse = await request(app).delete(`/api/tasks/${task.id}/stage-effort/implement`);
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body.stageEffortOverrides).toBeUndefined();
  });

  it("rejects invalid effort levels over HTTP", async () => {
    const task = await createTask(root, {
      title: "API invalid effort",
      description: "Validate effort over HTTP.",
      source: "manual",
      links: []
    });
    const app = createServer({ root });

    const rejected = await request(app)
      .post(`/api/tasks/${task.id}/stage-effort/implement`)
      .send({ effort: "turbo" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/invalid effort/i);
  });
});
