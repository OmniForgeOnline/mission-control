import { ui, workflowForTask } from "./state.js";
import type { HarnessTask, WorkflowSummary } from "./types.js";

type PmStatus = "backlog" | "in_progress" | "in_review" | "done";
type ExecutionState = "idle" | "running" | "blocked" | "paused";

const PM_RANK: Record<PmStatus, number> = {
  backlog: 0,
  in_progress: 1,
  in_review: 2,
  done: 3
};

const IN_PROGRESS_KINDS = new Set([
  "conversation",
  "agent_turn",
  "create_merge_request",
  "resolve_conflicts"
]);

export function getActiveStepIds(task: HarnessTask): string[] {
  const run = task.workflowRun;
  if (!run) return [];
  if (run.activeStepIds?.length) return run.activeStepIds;
  return [run.currentStepId];
}

function stepKind(workflow: WorkflowSummary, stepId: string): string {
  return workflow.steps[stepId]?.kind ?? "";
}

function currentStepNeedsApproval(task: HarnessTask, workflow: WorkflowSummary): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  const step = workflow.steps[run.currentStepId];
  if (!step || step.approval !== "required") return false;
  return run.stepApprovals[run.currentStepId]?.status !== "approved";
}

function derivePmStatus(task: HarnessTask, workflow: WorkflowSummary): PmStatus {
  if (task.resolution) return "done";
  const run = task.workflowRun;
  if (!run) return "in_progress";

  const kinds = getActiveStepIds(task).map((id) => stepKind(workflow, id));
  if (kinds.some((k) => k === "review")) return "in_review";
  if (kinds.some((k) => IN_PROGRESS_KINDS.has(k))) return "in_progress";

  const terminalId = run.currentStepId;
  if (stepKind(workflow, terminalId) === "terminal" && run.completedSteps.includes(terminalId)) {
    return isMergePending(task) ? "in_review" : "done";
  }
  return "in_progress";
}

/** A task with an MR/PR that has not been confirmed merged is still awaiting human action. */
export function isMergePending(task: HarnessTask): boolean {
  return Boolean(task.mergeRequest && !task.mergeRequest.mergedAt);
}

export function taskInflight(task: HarnessTask): boolean {
  return ui.data?.inflightTaskIds?.includes(task.id) ?? false;
}

export function taskExecution(task: HarnessTask): ExecutionState {
  if (task.resolution) return "idle";
  if (task.blockedReason) return "blocked";
  if (task.pausedAt) return "paused";
  if (taskInflight(task)) return "running";
  return "idle";
}

export function taskPmStatus(task: HarnessTask): PmStatus {
  const workflow = workflowForTask(task);
  if (!workflow) return "in_progress";
  const derived = derivePmStatus(task, workflow);
  const override = task.statusOverride?.value;
  if (!override || task.resolution) return derived;
  if (PM_RANK[derived] > PM_RANK[override]) return derived;
  return override;
}

export function taskIsRunning(task: HarnessTask): boolean {
  return taskExecution(task) === "running";
}

/** A ticket is complete once it has resolved (finished or cancelled). */
export function taskIsComplete(task: HarnessTask): boolean {
  const status = uiLegacyStatus(task);
  return status === "completed" || status === "cancelled";
}

/**
 * Whether the ticket has a harness worktree the operator can hand off to an editor.
 * Repo-backed tickets (repoPath + branch) keep one on disk until it is cleaned up;
 * everything else (scratch/non-repo targets, or already-cleaned worktrees) does not.
 */
export function canOpenWorktree(task: HarnessTask): boolean {
  return Boolean(task.repoPath && task.branch) && !task.worktreeCleanedAt;
}

function isAwaitingOperator(task: HarnessTask, workflow: WorkflowSummary): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  if (stepKind(workflow, run.currentStepId) !== "conversation") return false;
  return (task.messages ?? []).some((m) => m.author === "agent");
}

function isAwaitingReview(task: HarnessTask, workflow: WorkflowSummary): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  return (
    stepKind(workflow, run.currentStepId) === "review" &&
    task.reviewState === "none" &&
    (task.turnCount ?? 0) > 0
  );
}

function isTaskTerminal(task: HarnessTask, workflow: WorkflowSummary): boolean {
  if (task.resolution) return true;
  const run = task.workflowRun;
  if (!run) return false;
  return stepKind(workflow, run.currentStepId) === "terminal" && run.completedSteps.includes(run.currentStepId);
}

/** Maps the three-axis model to legacy status strings for transitional UI. */
export function uiLegacyStatus(task: HarnessTask): string {
  if (task.resolution === "cancelled") return "cancelled";
  if (task.resolution === "completed") return "completed";
  if (task.pausedAt) return "paused";
  if (task.interruptedAt) return "interrupted";
  if (task.blockedReason) return "blocked";

  const workflow = workflowForTask(task);
  if (!workflow) return "queued";

  if (taskIsRunning(task)) return "running";
  if (isAwaitingOperator(task, workflow)) return "awaiting_operator";
  if (isAwaitingReview(task, workflow)) return "awaiting_review";
  if (isTaskTerminal(task, workflow)) {
    return isMergePending(task) ? "awaiting_review" : "completed";
  }
  if (task.pushedAt) return "pushed";
  if (currentStepNeedsApproval(task, workflow)) return "queued";
  if (!task.approvedAt) return "queued";
  return "approved";
}