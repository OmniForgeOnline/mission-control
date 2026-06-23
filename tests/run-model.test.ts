import { describe, expect, it } from "vitest";

import { modelPoolDisplayName, stepRunModelPoolId } from "../src/ui/app/state.ts";
import type { HarnessRun, HarnessTask } from "../src/ui/app/types.ts";

function mkRun(overrides: Partial<HarnessRun> & Pick<HarnessRun, "id">): HarnessRun {
  return {
    taskId: "t1",
    taskTitle: "T",
    agent: "codex",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    artifacts: [],
    ...overrides
  };
}

function mkTask(overrides: Partial<HarnessTask> & Pick<HarnessTask, "id">): HarnessTask {
  return {
    title: "T",
    description: "",
    agent: "codex",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const pools = [
  { id: "codex-default", displayName: "Codex (default)" },
  { id: "claude-default", displayName: "Claude (default)" }
];

describe("modelPoolDisplayName", () => {
  it("resolves a known model pool id to its display name", () => {
    expect(modelPoolDisplayName("codex-default", pools)).toBe("Codex (default)");
  });

  it("falls back to the raw id for historical or unknown pools", () => {
    expect(modelPoolDisplayName("retired-pool", pools)).toBe("retired-pool");
  });

  it("returns null when no model is recorded", () => {
    expect(modelPoolDisplayName(undefined, pools)).toBeNull();
  });
});

describe("stepRunModelPoolId", () => {
  it("resolves a completed step from its own run, not the active run", () => {
    const task = mkTask({
      id: "t1",
      workflowRun: {
        workflowId: "wf",
        currentStepId: "implement",
        completedSteps: ["plan"],
        stepApprovals: {}
      }
    });
    const runs = [
      mkRun({ id: "r-implement", stepId: "implement", modelPoolId: "claude-default", startedAt: "2026-01-02T00:00:00.000Z" }),
      mkRun({ id: "r-plan", stepId: "plan", modelPoolId: "codex-default", startedAt: "2026-01-01T00:00:00.000Z" })
    ];

    expect(stepRunModelPoolId(task, "plan", runs)).toBe("codex-default");
    expect(stepRunModelPoolId(task, "implement", runs)).toBe("claude-default");
  });

  it("picks the newest run for a step when several exist (retries)", () => {
    const task = mkTask({
      id: "t1",
      workflowRun: { workflowId: "wf", currentStepId: "implement", completedSteps: ["plan"], stepApprovals: {} }
    });
    const runs = [
      mkRun({ id: "r-old", stepId: "plan", modelPoolId: "old-pool", startedAt: "2026-01-01T00:00:00.000Z" }),
      mkRun({ id: "r-fresh", stepId: "plan", modelPoolId: "fresh-pool", startedAt: "2026-01-03T00:00:00.000Z" })
    ];

    expect(stepRunModelPoolId(task, "plan", runs)).toBe("fresh-pool");
  });

  it("falls back to the active run for the executing step when that run predates step capture", () => {
    const task = mkTask({
      id: "t1",
      runId: "r-active",
      workflowRun: { workflowId: "wf", currentStepId: "implement", completedSteps: [], stepApprovals: {} }
    });
    const runs = [mkRun({ id: "r-active", modelPoolId: "legacy-pool", startedAt: "2026-01-02T00:00:00.000Z" })];

    expect(stepRunModelPoolId(task, "implement", runs)).toBe("legacy-pool");
  });

  it("does not label a completed step with the active run's model", () => {
    const task = mkTask({
      id: "t1",
      runId: "r-active",
      workflowRun: { workflowId: "wf", currentStepId: "implement", completedSteps: ["plan"], stepApprovals: {} }
    });
    // The plan run was pruned; only the active implement run remains.
    const runs = [mkRun({ id: "r-active", stepId: "implement", modelPoolId: "claude-default", startedAt: "2026-01-02T00:00:00.000Z" })];

    expect(stepRunModelPoolId(task, "plan", runs)).toBeUndefined();
  });

  it("returns undefined when no run exists for the step", () => {
    const task = mkTask({
      id: "t1",
      workflowRun: { workflowId: "wf", currentStepId: "implement", completedSteps: ["plan"], stepApprovals: {} }
    });

    expect(stepRunModelPoolId(task, "plan", [])).toBeUndefined();
  });
});
