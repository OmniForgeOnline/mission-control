import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask, setTaskResolution } from "../src/core/tasks/tasks.ts";
import {
  deriveExecution,
  derivePmStatus,
  effectivePmStatus,
  isAwaitingOperator,
  isTaskRunnable,
  migrateLegacyTaskStatus,
  pmStatusRank,
  shouldClearStatusOverride,
  type LegacyTaskStatus
} from "../src/core/tasks/status.ts";
import { createWorkflowRun, getActiveSteps } from "../src/core/workflows/run.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import type { HarnessTask } from "../src/core/types.ts";

type LegacyHarnessTask = HarnessTask & { status?: LegacyTaskStatus };

function taskWithRun(
  overrides: Partial<LegacyHarnessTask> & { workflowRun?: HarnessTask["workflowRun"] } = {}
): LegacyHarnessTask {
  return {
    id: "t1",
    title: "Test",
    description: "Desc",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workflowRun: {
      workflowId: "code-feature",
      currentStepId: "plan",
      completedSteps: [],
      stepApprovals: {}
    },
    ...overrides
  };
}

describe("workflow status derivation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-wf-status-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("maps legacy TaskStatus values to statusOverride/resolution fields", () => {
    const migrated = migrateLegacyTaskStatus(
      taskWithRun({ status: "completed", completedAt: "2026-01-02T00:00:00.000Z" })
    );
    expect("status" in migrated).toBe(false);
    expect(migrated.resolution).toBe("completed");

    const cancelled = migrateLegacyTaskStatus(taskWithRun({ status: "cancelled" }));
    expect(cancelled.resolution).toBe("cancelled");

    const paused = migrateLegacyTaskStatus(taskWithRun({ status: "paused" }));
    expect(paused.pausedAt).toBeDefined();

    const interrupted = migrateLegacyTaskStatus(taskWithRun({ status: "interrupted" }));
    expect(interrupted.interruptedAt).toBeDefined();

    const blocked = migrateLegacyTaskStatus(
      taskWithRun({ status: "blocked", blockedReason: "hook failed" })
    );
    expect(blocked.blockedReason).toBe("hook failed");
    expect(blocked.resolution).toBeUndefined();
  });

  it("derives pmStatus from workflow position", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const inProgress = taskWithRun({ workflowRun: { ...createWorkflowRun(workflow), currentStepId: "implement" } });
    expect(derivePmStatus(inProgress, workflow)).toBe("in_progress");

    const inReview = taskWithRun({ workflowRun: { ...createWorkflowRun(workflow), currentStepId: "review" } });
    expect(derivePmStatus(inReview, workflow)).toBe("in_review");

    const done = taskWithRun({
      workflowRun: {
        ...createWorkflowRun(workflow),
        currentStepId: "handoff",
        completedSteps: ["handoff"]
      }
    });
    expect(derivePmStatus(done, workflow)).toBe("done");
  });

  it("applies rank-based override precedence", () => {
    expect(pmStatusRank("backlog")).toBeLessThan(pmStatusRank("in_progress"));
    expect(
      shouldClearStatusOverride("backlog", "in_progress")
    ).toBe(true);
    expect(
      shouldClearStatusOverride("in_progress", "backlog")
    ).toBe(false);
    expect(
      shouldClearStatusOverride("in_review", "done")
    ).toBe(true);
  });

  it("effectivePmStatus uses override until outranked", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const task = taskWithRun({
      statusOverride: { value: "backlog", setAt: "2026-01-01T00:00:00.000Z" },
      workflowRun: { ...createWorkflowRun(workflow), currentStepId: "implement" }
    });
    expect(effectivePmStatus(task, workflow)).toBe("in_progress");

    const sticky = taskWithRun({
      statusOverride: { value: "in_review", setAt: "2026-01-01T00:00:00.000Z" },
      workflowRun: { ...createWorkflowRun(workflow), currentStepId: "implement" }
    });
    expect(effectivePmStatus(sticky, workflow)).toBe("in_review");
  });

  it("derives execution from runtime signals", () => {
    expect(deriveExecution(taskWithRun({ runId: "r1" }), { inflight: true })).toBe("running");
    expect(deriveExecution(taskWithRun({ runId: "r1" }))).toBe("idle");
    expect(deriveExecution(taskWithRun({ blockedReason: "fail" }))).toBe("blocked");
    expect(deriveExecution(taskWithRun({ pausedAt: "2026-01-01T00:00:00.000Z" }))).toBe("paused");
    expect(deriveExecution(taskWithRun())).toBe("idle");
  });

  it("getActiveSteps returns single current step in phase 1", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    expect(getActiveSteps(workflow, run)).toEqual([run.currentStepId]);
  });

  it("isAwaitingOperator detects conversation with agent turns", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const task = taskWithRun({
      messages: [{ id: "m1", author: "agent", body: "plan", createdAt: "2026-01-01T00:00:00.000Z" }],
      workflowRun: { ...createWorkflowRun(workflow), currentStepId: "plan" }
    });
    expect(isAwaitingOperator(task, workflow)).toBe(true);
  });

  it("isTaskRunnable excludes terminal and blocked tasks", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "implement";
    run.stepApprovals["implement"] = {
      stepId: "implement",
      status: "approved" as const,
      approvedAt: "2026-01-01T00:00:00.000Z"
    };
    const runnable = taskWithRun({
      approvedAt: "2026-01-01T00:00:00.000Z",
      workflowRun: run
    });
    expect(isTaskRunnable(runnable, workflow)).toBe(true);

    const blocked = taskWithRun({ blockedReason: "x" });
    expect(isTaskRunnable(blocked, workflow)).toBe(false);

    const done = taskWithRun({ resolution: "completed" });
    expect(isTaskRunnable(done, workflow)).toBe(false);
  });

  it("manual done sets resolution and is authoritative", async () => {
    const task = await createTask(root, {
      title: "Done early",
      description: "Stop work.",
      workflowId: "code-feature",
      source: "manual"
    });
    const updated = await setTaskResolution(root, task.id, "completed");
    expect(updated.resolution).toBe("completed");
    expect("status" in updated).toBe(false);
    expect((await getTask(root, task.id))?.resolution).toBe("completed");
  });

  it("normalize on load strips legacy status", async () => {
    const task = await createTask(root, {
      title: "Legacy",
      description: "Migrate me.",
      workflowId: "code-feature",
      source: "manual"
    });
    expect("status" in task).toBe(false);
  });
});