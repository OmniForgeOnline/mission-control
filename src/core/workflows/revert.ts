import { getStep, orderedStepIds } from "./graph.ts";
import type { WorkflowDefinition } from "./index.ts";
import type { HarnessTask, WorkflowRun } from "../types.ts";

/**
 * Step ids strictly downstream of `targetStepId` (the forward cone that will be
 * re-run after a revert). Computed against the canonical step ordering so it
 * covers parallel siblings and join targets.
 */
export function downstreamStepIds(workflow: WorkflowDefinition, targetStepId: string): string[] {
  const order = orderedStepIds(workflow);
  const index = order.indexOf(targetStepId);
  if (index === -1) return [];
  return order.slice(index + 1);
}

/** Kinds present in the forward cone of `targetStepId`, used to scope artifact cleanup. */
export function downstreamStepKinds(workflow: WorkflowDefinition, targetStepId: string): Set<string> {
  const kinds = new Set<string>();
  for (const id of downstreamStepIds(workflow, targetStepId)) {
    const kind = workflow.steps[id]?.kind;
    if (kind) kinds.add(kind);
  }
  return kinds;
}

/**
 * Rewind a workflow run back to `targetStepId`, discarding progress and per-step
 * outputs for the target and everything after it. Unlike a plain rollback, the
 * target step's own approval is retained so a revert-and-resume can run it
 * immediately without re-asking the operator to approve.
 */
export function rewindWorkflowRunForRevert(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  targetStepId: string
): WorkflowRun {
  const order = orderedStepIds(workflow);
  const index = order.indexOf(targetStepId);
  const ancestors = new Set<string>(index === -1 ? [] : order.slice(0, index));
  const keepApprovals = new Set<string>([...ancestors, targetStepId]);

  const completedSteps = run.completedSteps.filter((id) => ancestors.has(id));
  const stepApprovals = Object.fromEntries(
    Object.entries(run.stepApprovals).filter(([id]) => keepApprovals.has(id))
  );
  // Per-step run outputs produced at or after the target are stale once the
  // workflow re-runs from here; drop them so they regenerate on resume.
  const stepRuns = run.stepRuns
    ? Object.fromEntries(Object.entries(run.stepRuns).filter(([id]) => ancestors.has(id)))
    : undefined;

  const { activeStepIds: _clearedFrontier, ...rest } = run;
  return {
    ...rest,
    completedSteps,
    stepApprovals,
    ...(stepRuns ? { stepRuns } : {}),
    currentStepId: targetStepId
  };
}

/**
 * True when an operator may revert `task` to `targetStepId`: the step must exist,
 * must not be terminal, and must sit at or before the current workflow position so
 * a revert only ever moves the pointer backward (or re-runs the current step).
 */
export function canRevertToStep(
  workflow: WorkflowDefinition,
  task: HarnessTask,
  targetStepId: string
): boolean {
  const run = task.workflowRun;
  if (!run) return false;

  const order = orderedStepIds(workflow);
  const targetIndex = order.indexOf(targetStepId);
  if (targetIndex === -1) return false;

  const target = getStep(workflow, targetStepId);
  if (target.kind === "terminal") return false;

  const currentId = run.activeStepIds?.[0] ?? run.currentStepId;
  const currentIndex = order.indexOf(currentId);
  if (currentIndex === -1) return true;
  return targetIndex <= currentIndex;
}
