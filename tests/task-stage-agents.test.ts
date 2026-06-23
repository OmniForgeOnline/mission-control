import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { resolveAgentForStep } from "../src/core/agents/stage-agents.ts";
import {
  clearTaskStageAgentOverride,
  createTask,
  setTaskStageAgentOverride,
  updateTask
} from "../src/core/tasks/tasks.ts";
import { resetWorkflowCache } from "../src/core/workflows/index.ts";
import { createServer } from "../src/server/app.ts";

describe("task stage agents", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-task-stage-agents-"));
    resetWorkflowCache();
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("persists per-task stage agent overrides", async () => {
    const task = await createTask(root, {
      title: "Override agent",
      description: "Task-specific stage agent.",
      source: "manual",
      links: []
    });
    const updated = await setTaskStageAgentOverride(root, task.id, "implement", "claude");
    expect(updated.stageAgentOverrides).toEqual({ implement: "claude" });
    expect(
      await resolveAgentForStep(root, "code-feature", "implement", updated.stageAgentOverrides)
    ).toBe("claude");
  });

  it("clears per-task stage agent overrides", async () => {
    const task = await createTask(root, {
      title: "Clear override",
      description: "Reset to workflow default.",
      source: "manual",
      links: []
    });
    await setTaskStageAgentOverride(root, task.id, "implement", "claude");
    const cleared = await clearTaskStageAgentOverride(root, task.id, "implement");
    expect(cleared.stageAgentOverrides).toBeUndefined();
    expect(await resolveAgentForStep(root, "code-feature", "implement")).toBe("claude");
  });

  it("resets the resume attempt cap when the stage agent changes", async () => {
    const task = await createTask(root, {
      title: "Recover after usage limit",
      description: "Swap the agent to retry a capped step.",
      workflowId: "frontend-ui-change",
      source: "manual",
      links: []
    });
    // Simulate a step blocked after exhausting the resume budget on the prior agent.
    const capped = await updateTask(root, task.id, (current) => ({
      ...current,
      blockedReason: "Exceeded maximum resume attempts (3)",
      resumeAttempts: 3,
      workflowRun: {
        workflowId: "frontend-ui-change",
        currentStepId: "review",
        completedSteps: ["ux_scope", "implementation_plan", "implement_ui", "checks", "create_merge_request"],
        stepApprovals: {}
      }
    }));
    expect(capped.resumeAttempts).toBe(3);

    const swapped = await setTaskStageAgentOverride(root, task.id, "review", "claude");
    expect(swapped.stageAgentOverrides).toEqual({ review: "claude" });
    expect(swapped.resumeAttempts).toBe(0);
    expect(swapped.resumeAttemptsStepId).toBe("review");

    const reblocked = await updateTask(root, task.id, (current) => ({
      ...current,
      resumeAttempts: 3,
      resumeAttemptsStepId: "review"
    }));
    expect(reblocked.resumeAttempts).toBe(3);
    const cleared = await clearTaskStageAgentOverride(root, task.id, "review");
    expect(cleared.resumeAttempts).toBe(0);
    expect(cleared.resumeAttemptsStepId).toBe("review");
  });

  it("accepts any agent the dropdown surfaces, even non-legacy builtins like kiro", async () => {
    const task = await createTask(root, {
      title: "Dropdown agent",
      description: "Kiro is a registered builtin tool the dropdown presents.",
      source: "manual",
      links: []
    });
    const updated = await setTaskStageAgentOverride(root, task.id, "implement", "kiro");
    expect(updated.stageAgentOverrides).toEqual({ implement: "kiro" });
    expect(
      await resolveAgentForStep(root, "code-feature", "implement", updated.stageAgentOverrides)
    ).toBe("kiro");
  });

  it("rejects agent ids that are not registered in the agent config", async () => {
    const task = await createTask(root, {
      title: "Bogus agent",
      description: "Not a real tool.",
      source: "manual",
      links: []
    });
    await expect(
      setTaskStageAgentOverride(root, task.id, "implement", "not-a-real-agent")
    ).rejects.toThrow(/not registered/i);
  });

  it("rejects overrides on steps without agents", async () => {
    const task = await createTask(root, {
      title: "No agent step",
      description: "Terminal handoff step.",
      source: "manual",
      links: []
    });
    await expect(setTaskStageAgentOverride(root, task.id, "handoff", "claude")).rejects.toThrow(
      'Step "handoff" does not use an agent.'
    );
  });

  it("exposes task stage agent override endpoints", async () => {
    const task = await createTask(root, {
      title: "API override",
      description: "Set via HTTP.",
      source: "manual",
      links: []
    });
    const app = createServer({ root });

    const setResponse = await request(app)
      .post(`/api/tasks/${task.id}/stage-agents/implement`)
      .send({ agent: "codex" });
    expect(setResponse.status).toBe(200);
    expect(setResponse.body.stageAgentOverrides).toEqual({ implement: "codex" });

    const clearResponse = await request(app)
      .delete(`/api/tasks/${task.id}/stage-agents/implement`);
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body.stageAgentOverrides).toBeUndefined();
  });

  it("accepts dropdown agents and rejects unregistered ones over HTTP", async () => {
    const task = await createTask(root, {
      title: "API dropdown eligibility",
      description: "Validate against the agent config over HTTP.",
      source: "manual",
      links: []
    });
    const app = createServer({ root });

    const accepted = await request(app)
      .post(`/api/tasks/${task.id}/stage-agents/implement`)
      .send({ agent: "kiro" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.stageAgentOverrides).toEqual({ implement: "kiro" });

    const rejected = await request(app)
      .post(`/api/tasks/${task.id}/stage-agents/implement`)
      .send({ agent: "not-a-real-agent" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/not registered/i);
  });
});
