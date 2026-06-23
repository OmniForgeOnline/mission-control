import type { HarnessTask, PmStatus, Resolution, TaskStatus } from "../types.ts";
import { currentStepNeedsApproval, getActiveSteps, getCurrentStep } from "../workflows/run.ts";
import type { WorkflowDefinition } from "../workflows/index.ts";

export type ExecutionState = "idle" | "running" | "blocked" | "paused";

/** @deprecated Legacy status — used only during migration from persisted tasks. */
export type LegacyTaskStatus =
  | "queued"
  | "approved"
  | "running"
  | "awaiting_operator"
  | "awaiting_review"
  | "pushed"
  | "completed"
  | "blocked"
  | "paused"
  | "interrupted"
  | "cancelled";

const IN_PROGRESS_KINDS = new Set([
  "conversation",
  "agent_turn",
  "create_merge_request",
  "resolve_conflicts"
]);

export const PM_STATUS_RANK: Record<PmStatus, number> = {
  backlog: 0,
  in_progress: 1,
  in_review: 2,
  done: 3
};

export function pmStatusRank(status: PmStatus): number {
  return PM_STATUS_RANK[status];
}

export function shouldClearStatusOverride(override: PmStatus, derived: PmStatus): boolean {
  return pmStatusRank(derived) > pmStatusRank(override);
}

/**
 * A task is merge-pending when it has an associated MR/PR that has not yet been
 * confirmed merged. Such a task is awaiting human review/merge on the forge and
 * must not be treated as completed, even after the workflow reaches its terminal step.
 */
export function isMergePending(task: HarnessTask): boolean {
  return Boolean(task.mergeRequest && !task.mergeRequest.mergedAt);
}

export function derivePmStatus(task: HarnessTask, workflow: WorkflowDefinition): PmStatus {
  if (task.resolution) return "done";

  const run = task.workflowRun;
  if (!run) return "in_progress";

  const activeIds = getActiveSteps(workflow, run);
  const kinds = activeIds.map((id) => getCurrentStep(workflow, { ...run, currentStepId: id }).kind);
  if (kinds.some((k) => k === "review")) return "in_review";
  if (kinds.some((k) => IN_PROGRESS_KINDS.has(k))) return "in_progress";

  const terminalStep = getCurrentStep(workflow, run);
  if (terminalStep.kind === "terminal" && run.completedSteps.includes(terminalStep.id)) {
    return isMergePending(task) ? "in_review" : "done";
  }

  return "in_progress";
}

export function deriveExecution(
  task: HarnessTask,
  options?: { inflight?: boolean; activeRunCount?: number }
): ExecutionState {
  if (task.resolution) return "idle";
  if (task.blockedReason) return "blocked";
  if (task.pausedAt) return "paused";
  if (options?.inflight) return "running";
  return "idle";
}

export function effectivePmStatus(task: HarnessTask, workflow: WorkflowDefinition): PmStatus {
  const derived = derivePmStatus(task, workflow);
  const override = task.statusOverride?.value;
  if (!override) return derived;
  if (task.resolution) return "done";
  if (shouldClearStatusOverride(override, derived)) return derived;
  return override;
}

export function applyOverrideClearing(task: HarnessTask, workflow: WorkflowDefinition): HarnessTask {
  const override = task.statusOverride;
  if (!override || task.resolution) return task;
  const derived = derivePmStatus(task, workflow);
  if (!shouldClearStatusOverride(override.value, derived)) return task;
  const { statusOverride: _removed, ...rest } = task;
  return rest;
}

export function isTaskTerminal(task: HarnessTask, workflow: WorkflowDefinition): boolean {
  if (task.resolution) return true;
  const run = task.workflowRun;
  if (!run) return false;
  const step = getCurrentStep(workflow, run);
  return step.kind === "terminal" && run.completedSteps.includes(step.id);
}

export function isTaskRunning(task: HarnessTask, inflightIds?: string[]): boolean {
  const inflight = inflightIds?.includes(task.id) === true;
  return deriveExecution(task, inflight ? { inflight: true } : undefined) === "running";
}

export function isTaskResumable(task: HarnessTask): boolean {
  if (task.resolution) return false;
  return Boolean(task.pausedAt || task.interruptedAt || task.blockedReason);
}

export function isAwaitingOperator(task: HarnessTask, workflow: WorkflowDefinition): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  const step = getCurrentStep(workflow, run);
  if (step.kind !== "conversation") return false;
  const agentTurns = (task.messages ?? []).filter((m) => m.author === "agent").length;
  return agentTurns > 0;
}

export function isAwaitingReview(task: HarnessTask, workflow: WorkflowDefinition): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  const step = getCurrentStep(workflow, run);
  return step.kind === "review" && task.reviewState === "none" && (task.turnCount ?? 0) > 0;
}

export function isDaemonQueueCandidate(task: HarnessTask, workflow: WorkflowDefinition): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  if (task.resolution || task.blockedReason || task.pausedAt || task.interruptedAt) return false;
  if (currentStepNeedsApproval(workflow, run)) return false;
  if (isAwaitingOperator(task, workflow) || isAwaitingReview(task, workflow)) return false;
  if (isTaskRunning(task)) return false;
  if (isTaskTerminal(task, workflow)) return false;
  return true;
}

/** True when the current workflow step needs operator approval before running. */
export function isTaskQueuedForApproval(task: HarnessTask, workflow: WorkflowDefinition): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  return currentStepNeedsApproval(workflow, run);
}

export function isTaskRunnable(task: HarnessTask, workflow: WorkflowDefinition): boolean {
  if (task.resolution || task.blockedReason) return false;
  if (isTaskTerminal(task, workflow)) return false;
  if (currentStepNeedsApproval(workflow, task.workflowRun!)) return false;
  if (task.pausedAt || task.interruptedAt) return true;
  if (isAwaitingOperator(task, workflow) || isAwaitingReview(task, workflow)) return true;
  if (task.approvedAt) return true;
  const run = task.workflowRun;
  if (!run) return false;
  const step = getCurrentStep(workflow, run);
  return step.approval !== "required" || run.stepApprovals[step.id]?.status === "approved";
}

/** Maps the three-axis model to legacy status strings for transitional APIs. */
export function deriveLegacyStatus(
  task: HarnessTask,
  workflow: WorkflowDefinition,
  inflightIds?: string[]
): TaskStatus {
  if (task.resolution === "cancelled") return "cancelled";
  if (task.resolution === "completed") return "completed";
  if (task.pausedAt) return "paused";
  if (task.interruptedAt) return "interrupted";
  if (task.blockedReason) return "blocked";
  if (isTaskRunning(task, inflightIds)) return "running";
  if (isAwaitingOperator(task, workflow)) return "awaiting_operator";
  if (isAwaitingReview(task, workflow)) return "awaiting_review";
  if (isTaskTerminal(task, workflow)) {
    return isMergePending(task) ? "awaiting_review" : "completed";
  }
  if (task.pushedAt) return "pushed";

  const run = task.workflowRun;
  if (!run) return "queued";

  if (!task.approvedAt) {
    if (isAwaitingOperator(task, workflow)) return "awaiting_operator";
    return "queued";
  }

  const step = getCurrentStep(workflow, run);
  if (step.approval === "required") {
    const approved = run.stepApprovals[step.id]?.status === "approved";
    if (!approved) return "approved";
  }

  return "approved";
}

type LegacyTask = HarnessTask & { status?: LegacyTaskStatus };

export function migrateLegacyTaskStatus(task: LegacyTask): HarnessTask {
  if (!task.status) {
    const { status: _legacy, ...rest } = task;
    return rest;
  }

  const timestamp = task.updatedAt;
  let resolution: Resolution | undefined = task.resolution;
  let pausedAt: string | undefined = task.pausedAt;
  let interruptedAt: string | undefined = task.interruptedAt;
  let blockedReason: string | undefined = task.blockedReason;

  switch (task.status) {
    case "completed":
      resolution = "completed";
      break;
    case "cancelled":
      resolution = "cancelled";
      break;
    case "paused":
      pausedAt = pausedAt ?? timestamp;
      break;
    case "interrupted":
      interruptedAt = interruptedAt ?? timestamp;
      break;
    case "blocked":
      break;
    default:
      break;
  }

  const { status: _removed, ...rest } = task;
  return {
    ...rest,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(pausedAt !== undefined ? { pausedAt } : {}),
    ...(interruptedAt !== undefined ? { interruptedAt } : {}),
    ...(blockedReason !== undefined ? { blockedReason } : {})
  };
}
