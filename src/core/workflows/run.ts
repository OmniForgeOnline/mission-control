import type { HarnessTask, WorkflowRun } from "../types.ts";
import { findRepoRemediationStepId } from "./git-pipeline.ts";
import { DEFAULT_WORKFLOW_ID, findImplementationStepId, findMergeRequestStepId, getStep, type WorkflowDefinition } from "./index.ts";
import { advanceCompletedToken } from "./parallel.ts";

export function createWorkflowRun(workflow: WorkflowDefinition): WorkflowRun {
  return {
    workflowId: workflow.id,
    currentStepId: workflow.initial,
    completedSteps: [],
    stepApprovals: {}
  };
}

/** Single accessor for the workflow frontier (array in Phase 2). */
export function getActiveSteps(_workflow: WorkflowDefinition, run: WorkflowRun): string[] {
  if (run.activeStepIds !== undefined) return run.activeStepIds;
  return [run.currentStepId];
}

export function getCurrentStep(workflow: WorkflowDefinition, run: WorkflowRun) {
  const [stepId] = getActiveSteps(workflow, run);
  return getStep(workflow, stepId ?? run.currentStepId);
}

function isStepApproved(run: WorkflowRun, stepId: string): boolean {
  return run.stepApprovals[stepId]?.status === "approved";
}

export function markStepApproved(run: WorkflowRun, stepId: string): WorkflowRun {
  const timestamp = new Date().toISOString();
  return {
    ...run,
    stepApprovals: {
      ...run.stepApprovals,
      [stepId]: { stepId, status: "approved", approvedAt: timestamp }
    }
  };
}

function completeStep(run: WorkflowRun, stepId: string): WorkflowRun {
  const completedSteps = run.completedSteps.includes(stepId)
    ? run.completedSteps
    : [...run.completedSteps, stepId];
  return { ...run, completedSteps };
}

function advanceToStep(run: WorkflowRun, nextStepId: string): WorkflowRun {
  const completed = completeStep(run, run.currentStepId);
  return {
    ...completed,
    currentStepId: nextStepId
  };
}

/** Move the workflow pointer back to an earlier step (e.g. checks failure → author fix). */
export function jumpToWorkflowStep(run: WorkflowRun, stepId: string): WorkflowRun {
  const { activeStepIds: _frontier, ...rest } = run;
  return { ...rest, currentStepId: stepId };
}

/**
 * Return the workflow run on the implementation step for author remediation.
 * When still on review, follow the changes_requested branch; otherwise jump back
 * (e.g. concurrent review advanced to handoff before this verdict landed).
 */
export function routeWorkflowToImplementation(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  branch?: "changes_requested"
): WorkflowRun {
  const remediationStepId = findRepoRemediationStepId(workflow);
  if (!remediationStepId) return run;

  const currentStep = getCurrentStep(workflow, run);
  const approveRemediationStep = (nextRun: WorkflowRun): WorkflowRun => {
    const remediationStep = getStep(workflow, remediationStepId);
    return remediationStep.approval === "required" && !isStepApproved(nextRun, remediationStepId)
      ? markStepApproved(nextRun, remediationStepId)
      : nextRun;
  };

  if (
    currentStep.kind === "review" &&
    branch === "changes_requested" &&
    currentStep.branch?.["changes_requested"]
  ) {
    return approveRemediationStep(advanceWorkflowStep(workflow, run, "changes_requested").run);
  }

  const jumped = jumpToWorkflowStep(run, remediationStepId);
  return branch === "changes_requested" ? approveRemediationStep(jumped) : jumped;
}

/**
 * Reopen the create_merge_request step. Used to self-heal a run that reached
 * `review` with the step marked complete but no persisted merge request (e.g. the
 * step was advanced via an operator rollback/skip rather than executed). Only the
 * merge-request step is reopened; upstream checks stay completed and downstream
 * steps were never completed, so the handler re-runs idempotently and advances.
 */
export function routeWorkflowToMergeRequest(
  workflow: WorkflowDefinition,
  run: WorkflowRun
): WorkflowRun | null {
  const stepId = findMergeRequestStepId(workflow);
  if (!stepId) return null;
  const { activeStepIds: _frontier, ...rest } = run;
  return {
    ...rest,
    currentStepId: stepId,
    completedSteps: run.completedSteps.filter((id) => id !== stepId)
  };
}

function resolveNextStepId(workflow: WorkflowDefinition, run: WorkflowRun, branch?: string): string | null {
  const step = getCurrentStep(workflow, run);
  if (step.kind === "terminal") return null;
  if (branch && step.branch?.[branch]) {
    return step.branch[branch]!;
  }
  return step.next ?? null;
}

/**
 * Skip remaining planning/approval steps and land on the implementation step with
 * required approvals recorded. Used when the operator approves an existing plan.
 */
export function fastForwardToImplementStep(
  workflow: WorkflowDefinition,
  run: WorkflowRun
): WorkflowRun | null {
  const implementationStepId = findImplementationStepId(workflow);
  if (!implementationStepId) return null;

  let current = run;
  for (let guard = 0; guard < 12; guard++) {
    const step = getCurrentStep(workflow, current);
    if (step.id === implementationStepId) {
      return step.approval === "required" && !isStepApproved(current, step.id)
        ? markStepApproved(current, step.id)
        : current;
    }
    if (step.kind === "terminal") return null;

    if (step.approval === "required" && !isStepApproved(current, step.id)) {
      current = markStepApproved(current, step.id);
    }

    const { run: nextRun, done } = advanceWorkflowStep(workflow, current);
    if (done && getCurrentStep(workflow, nextRun).kind === "terminal") return null;
    current = nextRun;
  }

  return null;
}

export function advanceWorkflowStep(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  branch?: string,
  completedStepId?: string
): { run: WorkflowRun; done: boolean } {
  const stepId = completedStepId ?? getActiveSteps(workflow, run)[0] ?? run.currentStepId;
  const step = getStep(workflow, stepId);

  if (step.parallel?.length || step.join || run.activeStepIds !== undefined) {
    const nextRun = advanceCompletedToken(workflow, run, stepId, branch);
    const active = getActiveSteps(workflow, nextRun);
    if (active.length === 0) {
      return { run: nextRun, done: true };
    }
    return { run: nextRun, done: false };
  }

  const nextStepId = resolveNextStepId(workflow, run, branch);
  if (!nextStepId) {
    if (step.kind === "terminal") {
      const completed = completeStep(run, stepId);
      return { run: completed, done: true };
    }
    return { run, done: false };
  }
  return { run: advanceToStep(run, nextStepId), done: false };
}

export function currentStepNeedsApproval(workflow: WorkflowDefinition, run: WorkflowRun): boolean {
  const step = getCurrentStep(workflow, run);
  return step.approval === "required" && !isStepApproved(run, step.id);
}

export function normalizeTaskWorkflowRun(task: HarnessTask, workflows: Map<string, WorkflowDefinition>): HarnessTask {
  if (task.workflowRun) {
    const workflow = workflows.get(task.workflowRun.workflowId);
    if (!workflow) return task;
    return task;
  }

  const workflow = workflows.get(DEFAULT_WORKFLOW_ID);
  if (!workflow) return task;

  const run = createWorkflowRun(workflow);
  if (task.approvedAt) {
    run.stepApprovals[workflow.initial] = {
      stepId: workflow.initial,
      status: "approved",
      approvedAt: task.approvedAt
    };
  }
  return { ...task, workflowRun: run };
}
