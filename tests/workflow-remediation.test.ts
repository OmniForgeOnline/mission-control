import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import { routeTaskToImplementationStep } from "../src/core/tasks/tasks.ts";
import {
  GIT_WORKFLOW_IDS,
  collectPostPushStepIds,
  findRepoRemediationStepId,
  isGitWorkflow,
  isPostPushWorkflowStep,
  taskNeedsGitOperatorFollowup
} from "../src/core/workflows/git-pipeline.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import { createWorkflowRun, currentStepNeedsApproval, routeWorkflowToImplementation } from "../src/core/workflows/run.ts";

describe("git workflow remediation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-wf-remediation-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("recognizes all bundled git workflows", async () => {
    for (const id of GIT_WORKFLOW_IDS) {
      const workflow = await loadWorkflow(root, id);
      expect(isGitWorkflow(workflow)).toBe(true);
      expect(findRepoRemediationStepId(workflow)).toBeTruthy();
      expect(workflow.steps["review"]?.branch?.["changes_requested"]).toBe(findRepoRemediationStepId(workflow));
    }
  });

  it("routes changes_requested from review to each workflow's author step", async () => {
    const expected: Record<string, string> = {
      "code-feature": "implement",
      bugfix: "fix",
      "technical-debt": "implement",
      "infrastructure-change": "apply_change",
      "frontend-ui-change": "implement_ui"
    };

    for (const [workflowId, remediationStepId] of Object.entries(expected)) {
      const workflow = await loadWorkflow(root, workflowId);
      let run = createWorkflowRun(workflow);
      run = {
        ...run,
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", remediationStepId, "checks", "create_merge_request"]
      };

      const next = routeWorkflowToImplementation(workflow, run, "changes_requested");
      expect(next.currentStepId).toBe(remediationStepId);
    }
  });

  it("keeps reviewer-requested author rework runnable without a second operator approval", async () => {
    const workflow = await loadWorkflow(root, "frontend-ui-change");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "review",
      completedSteps: ["ux_scope", "implementation_plan", "implement_ui", "checks", "create_merge_request"]
    };

    const next = routeWorkflowToImplementation(workflow, run, "changes_requested");

    expect(next.currentStepId).toBe("implement_ui");
    expect(next.stepApprovals["implement_ui"]?.status).toBe("approved");
    expect(currentStepNeedsApproval(workflow, next)).toBe(false);
  });

  it("jumps to the author step when changes_requested arrives after handoff", async () => {
    for (const workflowId of GIT_WORKFLOW_IDS) {
      const workflow = await loadWorkflow(root, workflowId);
      const remediationStepId = findRepoRemediationStepId(workflow)!;
      let run = createWorkflowRun(workflow);
      run = {
        ...run,
        currentStepId: "handoff",
        completedSteps: [...run.completedSteps, remediationStepId, "checks", "create_merge_request", "review", "handoff"]
      };

      const next = routeWorkflowToImplementation(workflow, run, "changes_requested");
      expect(next.currentStepId).toBe(remediationStepId);
    }
  });

  it("treats capture_followups as post-push in technical-debt", async () => {
    const workflow = await loadWorkflow(root, "technical-debt");
    expect(isPostPushWorkflowStep(workflow, "capture_followups")).toBe(true);
    expect(collectPostPushStepIds(workflow).has("capture_followups")).toBe(true);
  });

  it("taskNeedsGitOperatorFollowup covers handoff and capture_followups", async () => {
    const workflow = await loadWorkflow(root, "technical-debt");
    const base = {
      messages: [],
      blockedReason: "Blocked at handoff",
      pushedAt: new Date().toISOString(),
      mergeRequest: { provider: "github" as const, url: "https://example.com/pr/1", number: 1 },
      workflowRun: {
        workflowId: "technical-debt",
        currentStepId: "capture_followups",
        completedSteps: [],
        stepApprovals: {}
      }
    };

    expect(taskNeedsGitOperatorFollowup(base, workflow)).toBe(true);
    expect(
      taskNeedsGitOperatorFollowup({ ...base, workflowRun: { ...base.workflowRun, currentStepId: "handoff" } }, workflow)
    ).toBe(true);
    expect(
      taskNeedsGitOperatorFollowup({ ...base, workflowRun: { ...base.workflowRun, currentStepId: "plan" } }, workflow)
    ).toBe(false);
  });

  it("routeTaskToImplementationStep clears blocked completion state", async () => {
    const { createTask, updateTask } = await import("../src/core/tasks/tasks.ts");
    const task = await createTask(root, {
      title: "Blocked at handoff",
      description: "Recover author.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    await updateTask(root, task.id, (current) => ({
      ...current,
      resolution: "completed",
      blockedReason: 'No agent configured for workflow step "handoff".',
      completedAt: new Date().toISOString(),
      pushedAt: new Date().toISOString(),
      commitCount: 2,
      workflowRun: {
        workflowId: "bugfix",
        currentStepId: "handoff",
        completedSteps: ["investigate", "plan_gate", "fix", "checks", "create_merge_request", "review", "handoff"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: new Date().toISOString() },
          fix: { stepId: "fix", status: "approved", approvedAt: new Date().toISOString() }
        }
      }
    }));

    const routed = await routeTaskToImplementationStep(root, task.id, "changes_requested");
    expect(routed.workflowRun?.currentStepId).toBe("fix");
    expect(await taskLegacyStatus(root, routed)).toBe("approved");
    expect(routed.resolution).toBeUndefined();
    expect(routed.blockedReason).toBeUndefined();
    expect(routed.completedAt).toBeUndefined();
    expect(routed.pushedAt).toBeUndefined();
    expect(routed.commitCount).toBeUndefined();
  });
});
