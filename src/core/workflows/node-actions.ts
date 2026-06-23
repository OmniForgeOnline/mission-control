import {
  advanceWorkflowStep,
  getActiveSteps,
  jumpToWorkflowStep,
  markStepApproved
} from "./run.ts";
import type { WorkflowDefinition } from "./index.ts";
import type { HarnessTask, WorkflowRun } from "../types.ts";

export type WorkflowNodeAction = "approve" | "jump" | "rollback" | "skip";

export function approveWorkflowStep(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  stepId: string
): WorkflowRun {
  const step = workflow.steps[stepId];
  if (!step || step.approval !== "required") return run;
  return markStepApproved(run, stepId);
}

export function jumpWorkflowToStep(run: WorkflowRun, stepId: string): WorkflowRun {
  return jumpToWorkflowStep(run, stepId);
}

/** Trim downstream progress and reopen the target step. */
export function rollbackWorkflowToStep(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  stepId: string
): WorkflowRun {
  const order = topologicalStepOrder(workflow);
  const targetIndex = order.indexOf(stepId);
  if (targetIndex === -1) return run;

  const keep = new Set(order.slice(0, targetIndex));
  const completedSteps = run.completedSteps.filter((id) => keep.has(id));
  const stepApprovals = Object.fromEntries(
    Object.entries(run.stepApprovals).filter(([id]) => keep.has(id))
  );

  const { activeStepIds: _cleared, ...rest } = run;
  return {
    ...rest,
    completedSteps,
    stepApprovals,
    currentStepId: stepId
  };
}

export function skipWorkflowStep(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  stepId: string
): { run: WorkflowRun; done: boolean } {
  const active = getActiveSteps(workflow, run);
  if (!active.includes(stepId)) {
    return { run, done: false };
  }
  const frontier = { ...run, currentStepId: stepId, activeStepIds: [stepId] };
  return advanceWorkflowStep(workflow, frontier);
}

function topologicalStepOrder(workflow: WorkflowDefinition): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  let stepId: string | undefined = workflow.initial;

  while (stepId && !seen.has(stepId)) {
    seen.add(stepId);
    order.push(stepId);
    const step: WorkflowDefinition["steps"][string] | undefined = workflow.steps[stepId];
    if (!step) break;
    if (step.parallel?.length) {
      stepId = step.parallel[0];
      continue;
    }
    stepId = step.next ?? step.branch?.["passed"] ?? step.branch?.["approved"];
  }

  return order;
}

export function applyWorkflowNodeAction(
  workflow: WorkflowDefinition,
  task: HarnessTask,
  stepId: string,
  action: WorkflowNodeAction
): WorkflowRun | null {
  const run = task.workflowRun;
  if (!run) return null;

  switch (action) {
    case "approve":
      return approveWorkflowStep(workflow, run, stepId);
    case "jump":
      return jumpWorkflowToStep(run, stepId);
    case "rollback":
      return rollbackWorkflowToStep(workflow, run, stepId);
    case "skip": {
      const { run: next } = skipWorkflowStep(workflow, run, stepId);
      return next;
    }
    default:
      return null;
  }
}

export function nodeActionAllowed(
  workflow: WorkflowDefinition,
  task: HarnessTask,
  stepId: string,
  action: WorkflowNodeAction
): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  const step = workflow.steps[stepId];
  if (!step) return false;

  switch (action) {
    case "approve":
      return step.approval === "required" && run.stepApprovals[stepId]?.status !== "approved";
    case "jump":
    case "rollback":
      return getActiveSteps(workflow, run).includes(stepId) || run.completedSteps.includes(stepId);
    case "skip":
      return getActiveSteps(workflow, run).includes(stepId) && step.kind !== "terminal";
    default:
      return false;
  }
}