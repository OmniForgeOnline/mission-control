import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  applyWorkflowNodeAction,
  approveWorkflowStep,
  nodeActionAllowed,
  rollbackWorkflowToStep
} from "../src/core/workflows/node-actions.ts";
import { createWorkflowRun } from "../src/core/workflows/run.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import type { HarnessTask } from "../src/core/types.ts";

function stubTask(run: ReturnType<typeof createWorkflowRun>): HarnessTask {
  const timestamp = new Date().toISOString();
  return {
    id: "t1",
    title: "T",
    description: "D",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    workflowRun: run
  };
}

describe("workflow node actions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-wf-node-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("approves a gated step", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "plan_gate";
    const next = approveWorkflowStep(workflow, run, "plan_gate");
    expect(next.stepApprovals["plan_gate"]?.status).toBe("approved");
    expect(nodeActionAllowed(workflow, stubTask(run), "plan_gate", "approve")).toBe(true);
  });

  it("rolls back downstream steps", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "implement";
    run.completedSteps = ["plan", "plan_gate"];
    const rewound = rollbackWorkflowToStep(workflow, run, "plan_gate");
    expect(rewound.currentStepId).toBe("plan_gate");
    expect(rewound.completedSteps).toEqual(["plan"]);
    expect(rewound.stepApprovals["plan_gate"]).toBeUndefined();
  });

  it("applyWorkflowNodeAction returns updated run", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "plan_gate";
    const task = stubTask(run);
    const updated = applyWorkflowNodeAction(workflow, task, "plan_gate", "approve");
    expect(updated?.stepApprovals["plan_gate"]?.status).toBe("approved");
  });

  it("does not allow approving a step that is not the active decision point", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    // createWorkflowRun starts at "plan"; plan_gate is an upcoming, unreached gate.
    expect(run.currentStepId).toBe("plan");
    expect(nodeActionAllowed(workflow, stubTask(run), "plan_gate", "approve")).toBe(false);
  });

  it("does not allow approving an active step while the task is running", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "plan_gate";
    expect(nodeActionAllowed(workflow, stubTask(run), "plan_gate", "approve", { running: true })).toBe(false);
    // Allowed again once the agent is idle.
    expect(nodeActionAllowed(workflow, stubTask(run), "plan_gate", "approve")).toBe(true);
  });
});