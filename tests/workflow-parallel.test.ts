import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import type { WorkflowRun } from "../src/core/types.ts";
import { loadWorkflow, resetWorkflowCache, workflowFilePath } from "../src/core/workflows/index.ts";
import {
  collectJoinPredecessors,
  isJoinReady
} from "../src/core/workflows/parallel.ts";
import { advanceTaskWorkflowStep } from "../src/core/tasks/tasks.ts";
import {
  advanceWorkflowStep,
  createWorkflowRun,
  getActiveSteps,
  jumpToWorkflowStep
} from "../src/core/workflows/run.ts";

// A dedicated fan-out workflow. No bundled workflow uses parallel branches any
// longer (mechanical checks folded into the implementation turn), but the
// parallel token engine is still general-purpose, so it gets its own fixture.
const PARALLEL_WORKFLOW = `
id: parallel-demo
name: Parallel Demo
initial: build
steps:
  build:
    kind: agent_turn
    agent: author
    skill: pr-driven-execution
    approval: required
    parallel:
      - pack_a
      - pack_b
      - pack_c
  pack_a:
    kind: agent_turn
    agent: none
    approval: none
    join: ship
    branch:
      failed: build
  pack_b:
    kind: agent_turn
    agent: none
    approval: none
    join: ship
    branch:
      failed: build
  pack_c:
    kind: agent_turn
    agent: none
    approval: none
    join: ship
    branch:
      failed: build
  ship:
    kind: agent_turn
    agent: reviewer
    approval: none
    next: done
  done:
    kind: terminal
    agent: none
    approval: none
`;

describe("workflow parallel tokens", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-wf-parallel-"));
    await ensureHarnessRepository(root);
    await mkdir(path.dirname(workflowFilePath(root, "parallel-demo")), { recursive: true });
    await writeFile(workflowFilePath(root, "parallel-demo"), PARALLEL_WORKFLOW, "utf8");
    resetWorkflowCache();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("fans build out to the parallel branches", async () => {
    const workflow = await loadWorkflow(root, "parallel-demo");
    expect(workflow.steps["build"]?.parallel).toEqual(["pack_a", "pack_b", "pack_c"]);
    expect(collectJoinPredecessors(workflow, "ship").sort()).toEqual([
      "pack_a",
      "pack_b",
      "pack_c"
    ]);

    let run = createWorkflowRun(workflow);
    run = { ...run, currentStepId: "build", completedSteps: ["build"] };
    ({ run } = advanceWorkflowStep(workflow, run));

    expect(getActiveSteps(workflow, run).sort()).toEqual(["pack_a", "pack_b", "pack_c"]);
  });

  it("fires the join target only after all parallel branches complete", async () => {
    const workflow = await loadWorkflow(root, "parallel-demo");
    let run: WorkflowRun = {
      ...createWorkflowRun(workflow),
      currentStepId: "pack_a",
      activeStepIds: ["pack_a", "pack_b", "pack_c"],
      completedSteps: ["build"]
    };

    ({ run } = advanceWorkflowStep(workflow, run, "passed", "pack_a"));
    expect(getActiveSteps(workflow, run).sort()).toEqual(["pack_b", "pack_c"]);
    expect(isJoinReady(workflow, run, "ship")).toBe(false);

    ({ run } = advanceWorkflowStep(workflow, run, "passed", "pack_b"));
    expect(getActiveSteps(workflow, run)).toEqual(["pack_c"]);
    expect(isJoinReady(workflow, run, "ship")).toBe(false);

    ({ run } = advanceWorkflowStep(workflow, run, "passed", "pack_c"));
    expect(getActiveSteps(workflow, run)).toEqual(["ship"]);
    expect(run.completedSteps).toEqual(
      expect.arrayContaining(["pack_a", "pack_b", "pack_c", "build"])
    );
  });

  it("routes a failed parallel branch back to build and clears sibling tokens", async () => {
    const workflow = await loadWorkflow(root, "parallel-demo");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "pack_a",
      activeStepIds: ["pack_a", "pack_b", "pack_c"],
      completedSteps: ["build"]
    };

    const { run: remediated } = advanceWorkflowStep(workflow, run, "failed", "pack_a");
    expect(getActiveSteps(workflow, remediated)).toEqual(["build"]);
    expect(remediated.completedSteps).toContain("pack_a");
    expect(remediated.activeStepIds).toBeUndefined();
  });

  it("keeps linear workflows working through next pointers", async () => {
    const workflow = await loadWorkflow(root, "bugfix");
    let run = createWorkflowRun(workflow);

    for (const expected of ["plan_gate", "fix", "create_merge_request"] as const) {
      ({ run } = advanceWorkflowStep(workflow, run));
      expect(run.currentStepId).toBe(expected);
      expect(run.activeStepIds).toBeUndefined();
    }
  });

  it("getActiveSteps prefers activeStepIds when the parallel frontier is set", async () => {
    const workflow = await loadWorkflow(root, "parallel-demo");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "build",
      activeStepIds: ["pack_a", "pack_b", "pack_c"],
      completedSteps: ["build"]
    };

    expect(getActiveSteps(workflow, run)).toEqual(["pack_a", "pack_b", "pack_c"]);
  });

  it("jumpToWorkflowStep clears the parallel frontier", async () => {
    const workflow = await loadWorkflow(root, "parallel-demo");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "pack_a",
      activeStepIds: ["pack_a", "pack_b", "pack_c"],
      completedSteps: ["build"]
    };

    const jumped = jumpToWorkflowStep(run, "build");
    expect(jumped.currentStepId).toBe("build");
    expect(jumped.activeStepIds).toBeUndefined();
    expect(getActiveSteps(workflow, jumped)).toEqual(["build"]);
  });

  it("advanceTaskWorkflowStep passes completedStepId for parallel tokens", async () => {
    const workflow = await loadWorkflow(root, "parallel-demo");
    const { createTask, updateTask } = await import("../src/core/tasks/tasks.ts");
    const task = await createTask(root, {
      title: "Parallel branches",
      description: "Run branches.",
      workflowId: "parallel-demo",
      source: "manual"
    });

    const run: WorkflowRun = {
      ...createWorkflowRun(workflow),
      currentStepId: "pack_a",
      activeStepIds: ["pack_a", "pack_b", "pack_c"],
      completedSteps: ["build"]
    };
    await updateTask(root, task.id, (current) => ({ ...current, workflowRun: run }));

    const afterA = await advanceTaskWorkflowStep(root, task.id, "passed", "pack_a");
    expect(getActiveSteps(workflow, afterA.workflowRun!).sort()).toEqual(["pack_b", "pack_c"]);
    expect(afterA.workflowRun?.completedSteps).toContain("pack_a");
  });

  it("preserves branch-only done semantics on review without a branch arg", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "review",
      completedSteps: ["plan", "plan_gate", "implement", "create_merge_request", "resolve_conflicts"]
    };

    const { run: stalled, done } = advanceWorkflowStep(workflow, run);
    expect(done).toBe(false);
    expect(stalled.currentStepId).toBe("review");
    expect(stalled.completedSteps).not.toContain("review");
  });
});
