import {
  isDaemonDrivenStep,
  isOperatorGatedStep
} from "@ui/app/workflow-steps.js";
import { getActiveStepIds, taskIsRunning } from "@ui/app/task-status.js";
import type { HarnessTask, WorkflowSummary } from "@ui/app/types.js";
import type { LayoutEdge } from "./layout.js";
import { countStepComments as countScopedStepComments } from "./step-messages.js";

export type NodeVisualState = "done" | "current" | "running" | "upcoming" | "blocked";

export interface DecoratedEdge extends LayoutEdge {
  done?: boolean;
  active?: boolean;
  branch?: boolean;
}

function completedStepsForCurrentFrontier(
  task: HarnessTask,
  workflow: WorkflowSummary
): Set<string> {
  const run = task.workflowRun;
  if (!run) return new Set();

  const completed = new Set(run.completedSteps);
  if (task.resolution) return completed;

  const active = getActiveStepIds(task);
  const activeIndexes = active
    .map((stepId) => workflow.stepIds.indexOf(stepId))
    .filter((index) => index >= 0);
  const frontierIndex = Math.min(...activeIndexes);
  if (!Number.isFinite(frontierIndex)) return completed;

  const rewoundToCompletedStep = active.some((stepId) => completed.has(stepId));
  if (!rewoundToCompletedStep) return completed;

  return new Set(
    run.completedSteps.filter((stepId) => {
      const index = workflow.stepIds.indexOf(stepId);
      return index < 0 || index < frontierIndex;
    })
  );
}

export function nodeVisualState(
  stepId: string,
  task: HarnessTask,
  workflow: WorkflowSummary
): NodeVisualState {
  const run = task.workflowRun;
  if (!run) return "upcoming";
  if (task.resolution) {
    return run.completedSteps.includes(stepId) ? "done" : "upcoming";
  }

  const active = getActiveStepIds(task);
  if (task.blockedReason && active.includes(stepId)) {
    return "blocked";
  }
  if (active.includes(stepId)) {
    if (taskIsRunning(task) && task.runId) return "running";
    return "current";
  }

  return completedStepsForCurrentFrontier(task, workflow).has(stepId) ? "done" : "upcoming";
}

export function nodeStateLabel(state: NodeVisualState): string {
  switch (state) {
    case "done":
      return "Done";
    case "running":
      return "Running";
    case "current":
      return "Current";
    case "blocked":
      return "Blocked";
    default:
      return "Upcoming";
  }
}

export function stepGateKind(
  workflow: WorkflowSummary,
  stepId: string
): "operator" | "daemon" | null {
  if (isOperatorGatedStep(workflow, stepId)) return "operator";
  if (isDaemonDrivenStep(workflow, stepId)) return "daemon";
  return null;
}

export function decorateLayoutEdges(
  edges: LayoutEdge[],
  task: HarnessTask,
  workflow: WorkflowSummary
): DecoratedEdge[] {
  const run = task.workflowRun;
  if (!run) {
    return edges.map((edge) => ({ ...edge, branch: edge.kind === "branch" }));
  }

  const active = new Set(getActiveStepIds(task));
  const completed = completedStepsForCurrentFrontier(task, workflow);

  return edges.map((edge) => {
    const branch = edge.kind === "branch";
    const done = completed.has(edge.from) && (completed.has(edge.to) || active.has(edge.to));
    const activeEdge =
      !branch &&
      (completed.has(edge.from) || active.has(edge.from)) &&
      (active.has(edge.to) || completed.has(edge.to));
    return {
      ...edge,
      branch,
      done,
      active: activeEdge && !done
    };
  });
}

export function countStepComments(task: HarnessTask, stepId: string): number {
  return countScopedStepComments(task.messages ?? [], stepId);
}

export function parallelPosition(
  stepId: string,
  workflow: WorkflowSummary
): { index: number; total: number; groupId: string } | null {
  for (const [groupId, step] of Object.entries(workflow.steps)) {
    if (!step.parallel?.includes(stepId)) continue;
    const index = step.parallel.indexOf(stepId);
    return { index: index + 1, total: step.parallel.length, groupId };
  }
  return null;
}
